const ExposedError = require('../../../data/exposed-error')
const { getAppealCommentType } = require('../../utils')

module.exports = async function resolveAppealUpdateMute (obj, { id, input }, { session, state }, info) {
  const data = await state.dbPool('bm_web_appeals')
    .where({ id })
    .first()

  if (!data) throw new ExposedError(`Appeal ${id} does not exist`)

  const server = state.serversPool.get(data.server_id)

  if (!server) throw new ExposedError('Server does not exist')

  const punishment = await server.pool(server.config.tables.playerMutes)
    .where({ id: data.punishment_id })
    .first()

  if (!punishment) throw new ExposedError('Punishment associated with this appeal no longer exists')

  const canUpdate = state.acl.hasServerPermission(data.server_id, 'player.appeals', 'update.state.any') ||
    (state.acl.hasServerPermission(data.server_id, 'player.appeals', 'update.state.own') && state.acl.owns(data.actor_id)) ||
    (state.acl.hasServerPermission(data.server_id, 'player.appeals', 'update.state.assigned') && state.acl.owns(data.assignee_id))
  const canUpdatePunishment = state.acl.hasServerPermission(data.server_id, 'player.mutes', 'update.any') ||
    (state.acl.hasServerPermission(data.server_id, 'player.mutes', 'update.own') && state.acl.owns(punishment.actor_id))

  if (!canUpdate || !canUpdatePunishment) {
    throw new ExposedError('You do not have permission to perform this action, please contact your server administrator')
  }

  let commentId

  await server.pool.transaction(async trx => {
    await trx(server.config.tables.playerMutes).update({ expires: input.expires, reason: input.reason, soft: input.soft ? 1 : 0 }).where({ id: data.punishment_id })

    return await state.dbPool.transaction(async trx => {
      const comment = {
        appeal_id: id,
        actor_id: session.playerId,
        state_id: 3,
        type: getAppealCommentType('editpunishment'),
        created: trx.raw('UNIX_TIMESTAMP()'),
        updated: trx.raw('UNIX_TIMESTAMP()')
      }

      if (punishment.expires !== input.expires) {
        comment.old_expires = punishment.expires
        comment.new_expires = input.expires
      }

      if (punishment.reason !== input.reason) {
        comment.old_reason = punishment.reason
        comment.new_reason = input.reason
      }

      if (Boolean(punishment.soft) !== input.soft) {
        comment.old_soft = punishment.soft
        comment.new_soft = input.soft ? 1 : 0
      }

      const [insertId] = await trx('bm_web_appeal_comments').insert(comment, ['id'])

      commentId = insertId

      return trx('bm_web_appeals').update({ updated: trx.raw('UNIX_TIMESTAMP()'), state_id: 3 }).where({ id })
    })
  })

  return { appealId: id, commentId }
}
