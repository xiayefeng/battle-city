import EventEmitter from 'events'
import { channel, Channel, delay } from 'redux-saga'
import { fork, put, race, select, take } from 'redux-saga/effects'
import { MapRecord, TankFireInfo, TankRecord } from 'types'
import { determineFire, getEnv } from './AI-utils'
import { State } from '../reducers'
import directionController from '../sagas/directionController'
import fireController from '../sagas/fireController'
import { getDirectionInfo } from '../utils/common'
import * as selectors from '../utils/selectors'
import { findPath, getPosInfoArray, getSpot, mergeEstMap, PosInfo, } from 'ai/shortest-path'

const logAI = (...args: any[]) =>
  console.log('%c AI ', 'background: #666;color:white;font-weight: bold', ...args)
const logNote = (...args: any[]) =>
  console.log('%c NOTE ', 'background: #222; color: #bada55', ...args)
const logCommand = (...args: any[]) =>
  console.log('%c COMMAND ', 'background: #222; color: steelblue; font-weight: bold', ...args)

function* waitFor(emitter: EventEmitter, expectedType: string) {
  let callback: any
  try {
    yield new Promise(resolve => {
      callback = resolve
      emitter.addListener(expectedType, resolve)
    })
  } finally {
    emitter.removeListener(expectedType, callback)
  }
}

// yield fork(function* notifyWhenBulletComplete() {
//   while (true) {
//     // TODO 修复BUG
//     const { bullets }: Action.DestroyBulletsAction = yield take('DESTROY_BULLETS')
//     const tank = yield select(selectors.playerTank, playerName)
//     if (tank != null) {
//       if (bullets.some(b => (b.tankId === tank.tankId))) {
//         console.debug('bullet-completed. notify')
//         noteChannel.put({ type: 'bullet-complete' })
//       }
//     }
//   }
// })
function getDirection(t1: number, t2: number): Direction {
  if (t2 === t1 + 1) return 'right'
  if (t2 === t1 - 1) return 'left'
  if (t2 === t1 + 26) return 'down'
  if (t2 === t1 - 26) return 'up'
  throw new Error('invalid direction')
}

function* followPath(ctx: AITankCtx, path: number[]) {
  logAI('start-follow-path')
  try {
    yield put<Action>({ type: 'SET_AI_TANK_PATH', path })
    const tank: TankRecord = yield select(selectors.playerTank, ctx.playerName)
    const start = getSpot(tank)
    let index = path.indexOf(start)
    console.assert(index !== -1)

    while (index < path.length - 1) {
      const direction = getDirection(path[index], path[index + 1])
      yield put<AICommand>(ctx.commandChannel, { type: 'turn', direction })
      const delta = path[index + 1] - path[index]
      let step = 1
      while (
        index + step + 1 < path.length &&
        path[index + step + 1] - path[index + step] === delta
      ) {
        step++
      }
      yield delay(100)
      // TODO forwardLength不一定就是 step * 8，有可能是一个小数
      yield put<AICommand>(ctx.commandChannel, { type: 'forward', forwardLength: step * 8 })
      // TODO 需要考虑移动失败（例如碰到了障碍物）的情况
      yield waitFor(ctx.noteEmitter, 'reach')
      index += step
    }
  } finally {
    yield put<Action>({ type: 'REMOVE_AI_TANK_PATH' })
  }
}

function calculateFireEstimateMap(spots: number[], posInfoArray: PosInfo[], map: MapRecord) {
  return spots.map(spot => posInfoArray[spot].getIdealFireEstMap(map)).reduce(mergeEstMap)
}

function randint(start: number, end: number) {
  return Math.floor(Math.random() * (end - start)) + start
}

function getRandomPassablePos(posInfoArray: PosInfo[]) {
  while (true) {
    const t = randint(0, 26 ** 2)
    if (posInfoArray[t].canPass) {
      return t
    }
  }
}

function* wanderMode(ctx: AITankCtx) {
  while (true) {
    const tank: TankRecord = yield select(selectors.playerTank, ctx.playerName)
    const { map }: State = yield select()
    const posInfoArray = getPosInfoArray(map)

    // const estMap = calculateFireEstimateMap(around(getSpot(map.eagle)), posInfoArray, map)
    const path = findPath(posInfoArray, getSpot(tank), getRandomPassablePos(posInfoArray))
    yield* followPath(ctx, path)
  }
}

function* moveLoop(ctx: AITankCtx) {
  while (true) {
    yield take(
      (action: Action) => action.type === 'ACTIVATE_PLAYER' && action.playerName === ctx.playerName,
    )
    // if (Math.random() < 1) {
    yield* wanderMode(ctx)
    // }
  }
}

function* fireLoop(ctx: AITankCtx) {
  let skipDelayAtFirstTime = true
  while (true) {
    if (skipDelayAtFirstTime) {
      skipDelayAtFirstTime = false
    } else {
      yield race({
        timeout: delay(300),
        bulletComplete: waitFor(ctx.noteEmitter, 'bullet-complete'),
      })
    }

    let tank = yield select(selectors.playerTank, ctx.playerName)
    if (tank == null) {
      continue
    }
    const fireInfo: TankFireInfo = yield select(selectors.fireInfo, ctx.playerName)
    if (fireInfo.canFire) {
      const { map, tanks }: State = yield select()

      const env = getEnv(map, tanks, tank)
      if (determineFire(tank, env)) {
        yield put<AICommand>(ctx.commandChannel, { type: 'fire' })
        yield delay(500)
      }
    }
  }
}

function* handleCommands(ctx: AITankCtx) {
  while (true) {
    const command: AICommand = yield take(ctx.commandChannel)
    logCommand(command)
    if (command.type === 'forward') {
      const tank = yield select(selectors.playerTank, ctx.playerName)
      if (tank == null) {
        continue
      }
      const { xy } = getDirectionInfo(tank.direction)
      ctx.startPos = tank.get(xy)
      ctx.forwardLength = command.forwardLength
    } else if (command.type === 'fire') {
      ctx.fire = true
    } else if (command.type === 'turn') {
      ctx.nextDirection = command.direction
    } else {
      throw new Error()
    }
  }
}

function* getAIInput(ctx: AITankCtx) {
  const tank = yield select(selectors.playerTank, ctx.playerName)
  if (tank == null) {
    return null
  }
  // fixme 转向的时候会将当前前进的信息清除, 导致转向命令和前进命令不能共存
  if (ctx.nextDirection && tank.direction !== ctx.nextDirection) {
    const direction = ctx.nextDirection
    ctx.nextDirection = null
    ctx.forwardLength = 0
    return { type: 'turn', direction }
  } else if (ctx.forwardLength > 0) {
    const { xy } = getDirectionInfo(tank.direction)
    const movedLength = Math.abs(tank.get(xy) - ctx.startPos)
    const maxDistance = ctx.forwardLength - movedLength
    if (movedLength === ctx.forwardLength) {
      ctx.forwardLength = 0
      logNote('reach')
      ctx.noteEmitter.emit('reach')
      return null
    } else {
      return {
        type: 'forward',
        maxDistance,
      }
    }
  }
  return null
}

function shouldFire(ctx: AITankCtx) {
  if (ctx.fire) {
    ctx.fire = false
    return true
  } else {
    return false
  }
}

class AITankCtx {
  fire = false
  nextDirection: Direction = null
  forwardLength = 0
  startPos = 0

  constructor(
    readonly playerName: string,
    readonly commandChannel: Channel<AICommand>,
    readonly noteEmitter: EventEmitter,
  ) {}
}

/**
 * AIWorkerSaga对应一个正在游戏中的AI玩家.
 * 当一个AI玩家坦克创建/激活时, 一个AIWorkerSaga实例将被创建
 * 当AI玩家的坦克被击毁时, saga实例将停止运行
 * 一个AIWorkerSaga实例总是对应一个正在游戏中的AI玩家坦克
 *
 * 在创建AiWorkerSaga的过程中, 将创建worker对象,
 * 并将创建noteChannel和commandChannel
 * 游戏逻辑和AI逻辑使用这两个channel来进行数据交换
 */
export default function* AIWorkerSaga(playerName: string) {
  const ctx = new AITankCtx(playerName, channel<AICommand>(), new EventEmitter())

  yield fork(directionController, playerName, () => getAIInput(ctx))
  yield fork(fireController, playerName, () => shouldFire(ctx))

  yield fork(moveLoop, ctx)
  yield fork(fireLoop, ctx)
  yield fork(handleCommands, ctx)
}
