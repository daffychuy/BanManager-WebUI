const ExposedError = require('../../../data/exposed-error')
const report = require('../queries/report')
const { fromUnixTime } = require('date-fns')
const { formatDistanceAbbr } = require('../../utils')

module.exports = async function resolveReportWarning (obj, { report: reportId, serverId, input }, { session, state }, info) {
  const server = state.serversPool.get(serverId)

  if (!server) throw new ExposedError('Server does not exist')

  const table = server.config.tables.playerReports
  const player = input.player
  const actor = session.playerId

  const [data] = await server.pool(table).where({ id: reportId })

  if (!data) throw new ExposedError(`Report ${reportId} does not exist`)

  const canUpdate = state.acl.hasServerPermission(serverId, 'player.reports', 'update.state.any') ||
    (state.acl.hasServerPermission(serverId, 'player.reports', 'update.state.own') && state.acl.owns(data.actor_id)) ||
    (state.acl.hasServerPermission(serverId, 'player.reports', 'update.state.assigned') && state.acl.owns(data.assignee_id)) ||
    (state.acl.hasServerPermission(serverId, 'player.reports', 'update.state.reported') && state.acl.owns(data.player_id))

  if (!canUpdate) {
    throw new ExposedError('You do not have permission to perform this action, please contact your server administrator')
  }

  const { name } = await server.pool(server.config.tables.players).select('name').where({ id: player }).first()
  const expires = input.expires !== 0 ? formatDistanceAbbr(fromUnixTime(input.expires)) : ''

  await server.pool.transaction(async trx => {
    await trx(server.config.tables.playerWarnings).insert({
      player_id: player,
      actor_id: actor,
      reason: input.reason,
      expires: input.expires,
      points: input.points,
      read: 0,
      created: trx.raw('UNIX_TIMESTAMP()')
    })

    if (input.points > 1) {
      input.reason = `-p ${input.points} ${input.reason}`
    }

    await trx(server.config.tables.playerReportCommands).insert({
      report_id: reportId,
      actor_id: actor,
      command: input.expires === 0 ? 'warn' : 'tempwarn',
      args: input.expires === 0 ? `${name} ${input.reason}` : `${name} ${expires} ${input.reason}`,
      created: trx.raw('UNIX_TIMESTAMP()'),
      updated: trx.raw('UNIX_TIMESTAMP()')
    })

    return trx(table).update({ updated: trx.raw('UNIX_TIMESTAMP()'), state_id: 3 }).where({ id: reportId })
  })

  return report(obj, { id: reportId, serverId }, { state }, info)
}
