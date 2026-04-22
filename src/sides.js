import { remoteSide } from './api.js'
import { localSide } from './local.js'

// 方向別の source / destination 構成:
//  upload   : source=local (full ignore で列挙),   destination=remote (mirror 削除時のみ local ignore で保護)
//  download : source=remote (ALWAYS_EXCLUDE のみ), destination=local  (ALWAYS_EXCLUDE のみで列挙し remote 内容を忠実に反映、mirror 削除時は local ignore で保護)
export function createSides(direction, { localDir, client, fullIgnore }) {
  if (direction === 'upload') {
    return {
      source: localSide(localDir, { listFilter: fullIgnore }),
      destination: remoteSide(client, { shouldSkipDelete: fullIgnore }),
    }
  }
  return {
    source: remoteSide(client),
    destination: localSide(localDir, { shouldSkipDelete: fullIgnore }),
  }
}
