// 並列度制限付き map。結果は入力順で返る。
// limit <= 0 や items が空の場合は空配列を返す。
export async function runWithLimit(items, limit, task) {
  const results = new Array(items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await task(items[i], i)
    }
  }
  const workerCount = Math.min(Math.max(limit, 1), items.length)
  const workers = Array.from({ length: workerCount }, worker)
  await Promise.all(workers)
  return results
}

// 再帰的な走査などで同時実行数 (≒ fd 同時オープン数) を抑えたいときに使う。
// `run(task)` は permit を獲得してから task を実行し、必ず解放する。
export function createSemaphore(limit) {
  const max = Math.max(limit, 1)
  let inFlight = 0
  const waiters = []
  const acquire = () =>
    new Promise((resolve) => {
      if (inFlight < max) {
        inFlight++
        resolve()
      } else {
        waiters.push(resolve)
      }
    })
  const release = () => {
    const next = waiters.shift()
    if (next) next()
    else inFlight--
  }
  return {
    async run(task) {
      await acquire()
      try {
        return await task()
      } finally {
        release()
      }
    },
  }
}
