/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';
import type {FiberRoot} from './ReactFiberRoot';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {ReactPriorityLevel} from './SchedulerWithReactIntegration';
import type {Interaction} from 'scheduler/src/Tracing';
import type {SuspenseConfig} from './ReactFiberSuspenseConfig';
import type {SuspenseState} from './ReactFiberSuspenseComponent';

import {
  warnAboutDeprecatedLifecycles,
  enableUserTimingAPI,
  enableSuspenseServerRenderer,
  replayFailedUnitOfWorkWithInvokeGuardedCallback,
  enableProfilerTimer,
  enableSchedulerTracing,
  warnAboutUnmockedScheduler,
  flushSuspenseFallbacksInTests,
  disableSchedulerTimeoutBasedOnReactExpirationTime,
} from 'shared/ReactFeatureFlags';
import ReactSharedInternals from 'shared/ReactSharedInternals';
import invariant from 'shared/invariant';
import warning from 'shared/warning';

import {
  scheduleCallback,
  cancelCallback,
  getCurrentPriorityLevel,
  runWithPriority,
  shouldYield,
  requestPaint,
  now,
  NoPriority,
  ImmediatePriority,
  UserBlockingPriority,
  NormalPriority,
  LowPriority,
  IdlePriority,
  flushSyncCallbackQueue,
  scheduleSyncCallback,
} from './SchedulerWithReactIntegration';

// The scheduler is imported here *only* to detect whether it's been mocked
import * as Scheduler from 'scheduler';

import {__interactionsRef, __subscriberRef} from 'scheduler/tracing';

import {
  prepareForCommit,
  resetAfterCommit,
  scheduleTimeout,
  cancelTimeout,
  noTimeout,
  warnsIfNotActing,
} from './ReactFiberHostConfig';

import {createWorkInProgress, assignFiberPropertiesInDEV} from './ReactFiber';
import {
  isRootSuspendedAtTime,
  markRootSuspendedAtTime,
  markRootFinishedAtTime,
  markRootUpdatedAtTime,
  markRootExpiredAtTime,
} from './ReactFiberRoot';
import {
  NoMode,
  StrictMode,
  ProfileMode,
  BlockingMode,
  ConcurrentMode,
} from './ReactTypeOfMode';
import {
  HostRoot,
  ClassComponent,
  SuspenseComponent,
  SuspenseListComponent,
  FunctionComponent,
  ForwardRef,
  MemoComponent,
  SimpleMemoComponent,
} from 'shared/ReactWorkTags';
import {
  NoEffect,
  PerformedWork,
  Placement,
  Update,
  PlacementAndUpdate,
  Deletion,
  Ref,
  ContentReset,
  Snapshot,
  Callback,
  Passive,
  Incomplete,
  HostEffectMask,
  Hydrating,
  HydratingAndUpdate,
} from 'shared/ReactSideEffectTags';
import {
  NoWork,
  Sync,
  Never,
  msToExpirationTime,
  expirationTimeToMs,
  computeInteractiveExpiration,
  computeAsyncExpiration,
  computeSuspenseExpiration,
  inferPriorityFromExpirationTime,
  LOW_PRIORITY_EXPIRATION,
  Batched,
  Idle,
} from './ReactFiberExpirationTime';
import {beginWork as originalBeginWork} from './ReactFiberBeginWork';
import {completeWork} from './ReactFiberCompleteWork';
import {unwindWork, unwindInterruptedWork} from './ReactFiberUnwindWork';
import {
  throwException,
  createRootErrorUpdate,
  createClassErrorUpdate,
} from './ReactFiberThrow';
import {
  commitBeforeMutationLifeCycles as commitBeforeMutationEffectOnFiber,
  commitLifeCycles as commitLayoutEffectOnFiber,
  commitPassiveHookEffects,
  commitPlacement,
  commitWork,
  commitDeletion,
  commitDetachRef,
  commitAttachRef,
  commitResetTextContent,
} from './ReactFiberCommitWork';
import {enqueueUpdate} from './ReactUpdateQueue';
import {resetContextDependencies} from './ReactFiberNewContext';
import {resetHooks, ContextOnlyDispatcher} from './ReactFiberHooks';
import {createCapturedValue} from './ReactCapturedValue';

import {
  recordCommitTime,
  startProfilerTimer,
  stopProfilerTimerIfRunningAndRecordDelta,
} from './ReactProfilerTimer';

// DEV stuff
import warningWithoutStack from 'shared/warningWithoutStack';
import getComponentName from 'shared/getComponentName';
import ReactStrictModeWarnings from './ReactStrictModeWarnings';
import {
  phase as ReactCurrentDebugFiberPhaseInDEV,
  resetCurrentFiber as resetCurrentDebugFiberInDEV,
  setCurrentFiber as setCurrentDebugFiberInDEV,
  getStackByFiberInDevAndProd,
} from './ReactCurrentFiber';
import {
  recordEffect,
  recordScheduleUpdate,
  startWorkTimer,
  stopWorkTimer,
  stopFailedWorkTimer,
  startWorkLoopTimer,
  stopWorkLoopTimer,
  startCommitTimer,
  stopCommitTimer,
  startCommitSnapshotEffectsTimer,
  stopCommitSnapshotEffectsTimer,
  startCommitHostEffectsTimer,
  stopCommitHostEffectsTimer,
  startCommitLifeCyclesTimer,
  stopCommitLifeCyclesTimer,
} from './ReactDebugFiberPerf';
import {
  invokeGuardedCallback,
  hasCaughtError,
  clearCaughtError,
} from 'shared/ReactErrorUtils';
import {onCommitRoot} from './ReactFiberDevToolsHook';

const ceil = Math.ceil;

const {
  ReactCurrentDispatcher,
  ReactCurrentOwner,
  IsSomeRendererActing,
} = ReactSharedInternals;

type ExecutionContext = number;

const NoContext = /*                    */ 0b000000; // 0
const BatchedContext = /*               */ 0b000001; // 1
const EventContext = /*                 */ 0b000010; // 2
const DiscreteEventContext = /*         */ 0b000100; // 4
const LegacyUnbatchedContext = /*       */ 0b001000; // 8
const RenderContext = /*                */ 0b010000; // 16
const CommitContext = /*                */ 0b100000; // 32

type RootExitStatus = 0 | 1 | 2 | 3 | 4 | 5;
const RootIncomplete = 0; // 未完成
const RootFatalErrored = 1; // 致命的错误
const RootErrored = 2; // 出错了
const RootSuspended = 3;
const RootSuspendedWithDelay = 4;
const RootCompleted = 5; // 已完成

export type Thenable = {
  then(resolve: () => mixed, reject?: () => mixed): Thenable | void,

  // Special flag to opt out of tracing interactions across a Suspense boundary.
  __reactDoNotTraceInteractions?: boolean,
};

// Describes where we are in the React execution stack
// React 的执行栈(别称，调用栈，`执行上下文栈`)
let executionContext: ExecutionContext = NoContext;
// The root we're working on
// 我们正在 work 的根
let workInProgressRoot: FiberRoot | null = null;
// The fiber we're working on
// 我们正在 work 的 fiber
let workInProgress: Fiber | null = null;
// The expiration time we're rendering
// 我们渲染的过期时间
let renderExpirationTime: ExpirationTime = NoWork;
// Whether to root completed, errored, suspended, etc.
// 是否根已完成，出错，挂起，等。
let workInProgressRootExitStatus: RootExitStatus = RootIncomplete;
// A fatal error, if one is thrown
// 致命错误（如果抛出）
let workInProgressRootFatalError: mixed = null;
// Most recent event time among processed updates during this render.
// This is conceptually a time stamp
// but expressed in terms of an ExpirationTime
// because we deal mostly with expiration times in the hot path,
// so this avoids the conversion happening in the hot path.
// 在此渲染期间，已处理的更新中的最新事件时间。
// 从概念上讲，这是一个时间戳，
// 但以ExpirationTime表示因为我们主要处理热路径中的到期时间，
// 所以可以避免转换发生在热门路径上。

let workInProgressRootLatestProcessedExpirationTime: ExpirationTime = Sync;
let workInProgressRootLatestSuspenseTimeout: ExpirationTime = Sync;
let workInProgressRootCanSuspendUsingConfig: null | SuspenseConfig = null;
// The work left over by components that were visited during this render. Only
// includes unprocessed updates, not work in bailed out children.
let workInProgressRootNextUnprocessedUpdateTime: ExpirationTime = NoWork;

// If we're pinged while rendering we don't always restart immediately.
// This flag determines if it might be worthwhile to restart if an opportunity
// happens latere.
let workInProgressRootHasPendingPing: boolean = false;
// The most recent time we committed a fallback. This lets us ensure a train
// model where we don't commit new loading states in too quick succession.
let globalMostRecentFallbackTime: number = 0;
const FALLBACK_THROTTLE_MS: number = 500;

let nextEffect: Fiber | null = null;
let hasUncaughtError = false;
let firstUncaughtError = null;
let legacyErrorBoundariesThatAlreadyFailed: Set<mixed> | null = null;

let rootDoesHavePassiveEffects: boolean = false;
let rootWithPendingPassiveEffects: FiberRoot | null = null;
let pendingPassiveEffectsRenderPriority: ReactPriorityLevel = NoPriority;
let pendingPassiveEffectsExpirationTime: ExpirationTime = NoWork;

let rootsWithPendingDiscreteUpdates: Map<
  FiberRoot,
  ExpirationTime,
> | null = null;

// Use these to prevent an infinite loop of nested updates
const NESTED_UPDATE_LIMIT = 50;
let nestedUpdateCount: number = 0;
let rootWithNestedUpdates: FiberRoot | null = null;

const NESTED_PASSIVE_UPDATE_LIMIT = 50;
let nestedPassiveUpdateCount: number = 0;

let interruptedBy: Fiber | null = null;

// Marks the need to reschedule pending interactions at these expiration times
// during the commit phase. This enables them to be traced across components
// that spawn new work during render. E.g. hidden boundaries, suspended SSR
// hydration or SuspenseList.
let spawnedWorkDuringRender: null | Array<ExpirationTime> = null;

// Expiration times are computed by adding to the current time (the start
// time). However, if two updates are scheduled within the same event, we
// should treat their start times as simultaneous, even if the actual clock
// time has advanced between the first and second call.

// In other words, because expiration times determine how updates are batched,
// we want all updates of like priority that occur within the same event to
// receive the same expiration time. Otherwise we get tearing.
let currentEventTime: ExpirationTime = NoWork;

export function requestCurrentTimeForUpdate() {
  if ((executionContext & (RenderContext | CommitContext)) !== NoContext) {
    // We're inside React, so it's fine to read the actual time.
    // 我们在React内部，因此可以读取实际时间。
    return msToExpirationTime(now());
  }
  // We're not inside React, so we may be in the middle of a browser event.
  // 我们不在React内部，因此我们可能处于浏览器事件的中间。
  if (currentEventTime !== NoWork) {
    // Use the same start time for all updates until we enter React again.
    // 对所有更新使用相同的开始时间，直到我们再次输入React。
    return currentEventTime;
  }
  // This is the first update since React yielded.
  // Compute a new start time.
  // 这是自React产生以来的第一次更新。
  // 计算新的开始时间。
  currentEventTime = msToExpirationTime(now());
  return currentEventTime;
}

export function getCurrentTime() {
  return msToExpirationTime(now());
}

// 计算 Fiber node 的过期时间
export function computeExpirationForFiber(
  currentTime: ExpirationTime,
  fiber: Fiber,
  suspenseConfig: null | SuspenseConfig,
): ExpirationTime {
  const mode = fiber.mode;
  if ((mode & BlockingMode) === NoMode) {
    // 优先级最高
    return Sync;
  }

  const priorityLevel = getCurrentPriorityLevel();
  if ((mode & ConcurrentMode) === NoMode) {
    return priorityLevel === ImmediatePriority ? Sync : Batched;
  }

  if ((executionContext & RenderContext) !== NoContext) {
    // Use whatever time we're already rendering
    // TODO: Should there be a way to opt out, like with `runWithPriority`?
    return renderExpirationTime;
  }

  let expirationTime;
  if (suspenseConfig !== null) {
    // Compute an expiration time based on the Suspense timeout.
    expirationTime = computeSuspenseExpiration(
      currentTime,
      suspenseConfig.timeoutMs | 0 || LOW_PRIORITY_EXPIRATION,
    );
  } else {
    // Compute an expiration time based on the Scheduler priority.
    switch (priorityLevel) {
      case ImmediatePriority:
        expirationTime = Sync;
        break;
      case UserBlockingPriority:
        // TODO: Rename this to computeUserBlockingExpiration
        expirationTime = computeInteractiveExpiration(currentTime);
        break;
      case NormalPriority:
      case LowPriority: // TODO: Handle LowPriority
        // TODO: Rename this to... something better.
        expirationTime = computeAsyncExpiration(currentTime);
        break;
      case IdlePriority:
        expirationTime = Idle;
        break;
      default:
        invariant(false, 'Expected a valid priority level');
    }
  }

  // If we're in the middle of rendering a tree, do not update at the same
  // expiration time that is already rendering.
  // TODO: We shouldn't have to do this if the update is on a different root.
  // Refactor computeExpirationForFiber + scheduleUpdate so we have access to
  // the root when we check for this condition.
  if (workInProgressRoot !== null && expirationTime === renderExpirationTime) {
    // This is a trick to move this update into a separate batch
    expirationTime -= 1;
  }

  return expirationTime;
}

// 安排 Fiber 更新
export function scheduleUpdateOnFiber(
  fiber: Fiber,
  expirationTime: ExpirationTime,
) {
  checkForNestedUpdates();
  warnAboutInvalidUpdatesOnClassComponentsInDEV(fiber);

  const root = markUpdateTimeFromFiberToRoot(fiber, expirationTime);
  if (root === null) {
    warnAboutUpdateOnUnmountedFiberInDEV(fiber);
    return;
  }

  checkForInterruption(fiber, expirationTime);
  recordScheduleUpdate();

  // TODO: computeExpirationForFiber also reads the priority. Pass the
  // priority as an argument to that function and this one.
  const priorityLevel = getCurrentPriorityLevel();

  //taichiyi 如果expirationTime等于最大整型值的话
  if (expirationTime === Sync) {
    if (
      // Check if we're inside unbatchedUpdates
      //taichiyi 当前 React 的`执行上下文栈`包含 LegacyUnbatchedContext
      (executionContext & LegacyUnbatchedContext) !== NoContext &&
      // Check if we're not already rendering
      //taichiyi 检查是否为首次渲染
      //taichiyi 当前 React 的`执行上下文栈`即不包含 RenderContext 也不包含 CommitContext
      (executionContext & (RenderContext | CommitContext)) === NoContext
    ) {
      // Register pending interactions on the root to avoid losing traced interaction data.
      // 在根上注册待处理的交互，以避免丢失跟踪的交互数据。

      //taichiyi 跟踪这些update，并计数、检测它们是否会报错
      schedulePendingInteractions(root, expirationTime);

      // This is a legacy edge case.
      // The initial mount of a ReactDOM.render-ed root inside of batchedUpdates should be synchronous,
      // but layout updates should be deferred until the end of the batch.
      // 这是一个过时的边缘情况。
      // 在 batchedUpdates 内部的ReactDOM.render根的初始安装应该是同步的，
      // 但是布局更新应该推迟到批处理结束。
      performSyncWorkOnRoot(root);
    } else {
      ensureRootIsScheduled(root);
      schedulePendingInteractions(root, expirationTime);
      //taichiyi React 的`执行上下文栈`为空
      if (executionContext === NoContext) {
        // Flush the synchronous work now, unless we're already working or inside a batch.
        // 立即清除同步工作，除非我们已经在工作或在批处理中。
        // This is intentionally inside scheduleUpdateOnFiber instead of scheduleCallbackForFiber to preserve the ability to schedule a callback without immediately flushing it.
        // 故意将其放置在scheduleUpdateOnFiber而不是scheduleCallbackForFiber内，以保留在不立即刷新回调的情况下调度回调的函数。
        // We only do this for user-initiated updates, to preserve historical behavior of legacy mode.
        // 我们仅对用户启动的更新执行此操作，以保留旧版模式的历史行为。
        flushSyncCallbackQueue();
      }
    }
  } else {
    ensureRootIsScheduled(root);
    schedulePendingInteractions(root, expirationTime);
  }

  if (
    (executionContext & DiscreteEventContext) !== NoContext &&
    // Only updates at user-blocking priority or greater are considered discrete, even inside a discrete event.
    // 即使具有离散事件，也仅将具有用户阻塞优先级或更高优先级的更新视为离散的。
    (priorityLevel === UserBlockingPriority ||
      priorityLevel === ImmediatePriority)
  ) {
    // This is the result of a discrete event.
    // Track the lowest priority discrete update per root so we can flush them early, if needed.
    // 这是离散事件的结果。
    // 跟踪每个根目录的最低优先级离散更新，以便我们在需要时可以尽早刷新它们。
    if (rootsWithPendingDiscreteUpdates === null) {
      rootsWithPendingDiscreteUpdates = new Map([[root, expirationTime]]);
    } else {
      const lastDiscreteTime = rootsWithPendingDiscreteUpdates.get(root);
      if (lastDiscreteTime === undefined || lastDiscreteTime > expirationTime) {
        rootsWithPendingDiscreteUpdates.set(root, expirationTime);
      }
    }
  }
}
export const scheduleWork = scheduleUpdateOnFiber;

// This is split into a separate function so we can mark a fiber with pending work without treating it as a typical update that originates from an event;
// 我们可以将 fiber 标记为待处理的工作，而无需将其视为源自事件的典型_update；
// e.g. retrying a Suspense boundary isn't an update, but it does schedule work on a fiber.
// 例如 重试Suspense边界不是 update，但可以在 fiber 上调度工作。

// 1. 获取root节点
// 2. 标记从 fiber 到 root 的更新时间
function markUpdateTimeFromFiberToRoot(fiber, expirationTime) {
  // Update the source fiber's expiration time
  // 更新源 fiber 的到期时间
  if (fiber.expirationTime < expirationTime) {
    fiber.expirationTime = expirationTime;
  }
  let alternate = fiber.alternate;
  if (alternate !== null && alternate.expirationTime < expirationTime) {
    alternate.expirationTime = expirationTime;
  }
  // Walk the parent path to the root and update the child expiration time.
  // 将父路径移至根，并更新子过期时间。
  let node = fiber.return;
  let root = null;
  if (node === null && fiber.tag === HostRoot) {
    //taichiyi fiber 为树根
    root = fiber.stateNode;
  } else {
    while (node !== null) {
      alternate = node.alternate;
      if (node.childExpirationTime < expirationTime) {
        node.childExpirationTime = expirationTime;
        if (
          alternate !== null &&
          alternate.childExpirationTime < expirationTime
        ) {
          alternate.childExpirationTime = expirationTime;
        }
      } else if (
        alternate !== null &&
        alternate.childExpirationTime < expirationTime
      ) {
        alternate.childExpirationTime = expirationTime;
      }
      if (node.return === null && node.tag === HostRoot) {
        root = node.stateNode;
        break;
      }
      node = node.return;
    }
  }

  if (root !== null) {
    if (workInProgressRoot === root) {
      // Received an update to a tree that's in the middle of rendering.
      // Mark that's unprocessed work on this root.
      // 收到了渲染中一棵树的更新。
      // 标记此根上尚未处理的工作。
      markUnprocessedUpdateTime(expirationTime);

      if (workInProgressRootExitStatus === RootSuspendedWithDelay) {
        // The root already suspended with a delay, which means this render definitely won't finish.
        // Since we have a new update, let's mark it as suspended now, right before marking the incoming update.
        // This has the effect of interrupting the current render and switching to the update.
        // 根目录已经延迟了暂停，这意味着此渲染肯定不会完成。
        // 由于我们有一个新的更新，因此在标记传入更新之前，现在将其标记为已暂停。
        // 这具有中断当前渲染并切换到更新的效果。

        // TODO: This happens to work when receiving an update during the render
        // phase, because of the trick inside computeExpirationForFiber to
        // subtract 1 from `renderExpirationTime` to move it into a
        // separate bucket. But we should probably model it with an exception,
        // using the same mechanism we use to force hydration of a subtree.

        // TODO: This does not account for low pri updates that were already
        // scheduled before the root started rendering. Need to track the next
        // pending expiration time (perhaps by backtracking the return path) and
        // then trigger a restart in the `renderDidSuspendDelayIfPossible` path.
        markRootSuspendedAtTime(root, renderExpirationTime);
      }
    }

    // Mark that the root has a pending update.
    // 标记 root 具有待处理的更新。
    markRootUpdatedAtTime(root, expirationTime);
  }

  return root;
}

//taichiyi 获取下一个根到期时间
function getNextRootExpirationTimeToWorkOn(root: FiberRoot): ExpirationTime {
  // Determines the next expiration time that the root should render, taking
  // into account levels that may be suspended, or levels that may have
  // received a ping.
  // 考虑到可能被暂停的级别或可能已收到ping的级别，确定根目录应呈现的下一个到期时间。

  const lastExpiredTime = root.lastExpiredTime;
  if (lastExpiredTime !== NoWork) {
    return lastExpiredTime;
  }

  // "Pending" refers to any update that hasn't committed yet, including if it suspended.
  // The "suspended" range is therefore a subset.
  // “待处理”是指尚未提交的任何更新，包括已暂停的更新。
  // 因此，“暂停”范围是一个子集。
  const firstPendingTime = root.firstPendingTime;
  if (!isRootSuspendedAtTime(root, firstPendingTime)) {
    // The highest priority pending time is not suspended. Let's work on that.
    // 最高优先级的挂起时间不会被挂起。让我们继续努力。
    return firstPendingTime;
  }

  // If the first pending time is suspended, check if there's a lower priority pending level that we know about.
  // Or check if we received a ping.
  // Work on whichever is higher priority.
  // 如果第一个待处理时间被暂停，请检查是否有我们知道的较低优先级待处理级别。
  // 或检查我们是否收到ping命令。
  // Work 以较高优先级为准。
  const lastPingedTime = root.lastPingedTime;
  const nextKnownPendingLevel = root.nextKnownPendingLevel;
  return lastPingedTime > nextKnownPendingLevel
    ? lastPingedTime
    : nextKnownPendingLevel;
}

// Use this function to schedule a task for a root. There's only one task per root;
// if a task was already scheduled, we'll check to make sure the expiration time of the existing task is the same as the expiration time of the next level that the root has work on.
// This function is called on every update, and right before exiting a task.
// 使用此函数可以安排根任务。每个根只有一项任务；
// 如果已经安排了任务，我们将进行检查以确保现有任务的到期时间与根已处理的下一级别的到期时间相同。
// 每次更新时都会在退出任务之前调用此函数。

//taichiyi 确保 FiberRoot 节点(下一时刻)被调度
function ensureRootIsScheduled(root: FiberRoot) {
  const lastExpiredTime = root.lastExpiredTime;
  if (lastExpiredTime !== NoWork) {
    // Special case: Expired work should flush synchronously.
    // 特殊情况：过期的工作应同步冲洗。
    root.callbackExpirationTime = Sync;
    root.callbackPriority = ImmediatePriority;
    //
    // 同步的React回调被安排在一个特殊的内部同步队列中
    root.callbackNode = scheduleSyncCallback(
      performSyncWorkOnRoot.bind(null, root),
    );
    return;
  }

  const expirationTime = getNextRootExpirationTimeToWorkOn(root);
  const existingCallbackNode = root.callbackNode;
  if (expirationTime === NoWork) {
    // There's nothing to work on.
    if (existingCallbackNode !== null) {
      root.callbackNode = null;
      root.callbackExpirationTime = NoWork;
      root.callbackPriority = NoPriority;
    }
    return;
  }

  // TODO: If this is an update, we already read the current time. Pass the time as an argument.
  // TODO: 如果这是更新，我们已经阅读了当前时间。 通过时间作为参数。
  const currentTime = requestCurrentTimeForUpdate();
  const priorityLevel = inferPriorityFromExpirationTime(
    currentTime,
    expirationTime,
  );

  // If there's an existing render task, confirm it has the correct priority and expiration time.
  // Otherwise, we'll cancel it and schedule a new one.
  // 如果存在现有的渲染任务，请确认其具有正确的优先级和到期时间。
  // 否则，我们将取消它并安排一个新的。
  if (existingCallbackNode !== null) {
    const existingCallbackPriority = root.callbackPriority;
    const existingCallbackExpirationTime = root.callbackExpirationTime;
    if (
      // Callback must have the exact same expiration time.
      existingCallbackExpirationTime === expirationTime &&
      // Callback must have greater or equal priority.
      existingCallbackPriority >= priorityLevel
    ) {
      // Existing callback is sufficient.
      return;
    }
    // Need to schedule a new task.
    // TODO: Instead of scheduling a new task, we should be able to change the priority of the existing one.
    cancelCallback(existingCallbackNode);
  }

  root.callbackExpirationTime = expirationTime;
  root.callbackPriority = priorityLevel;

  let callbackNode;
  if (expirationTime === Sync) {
    // Sync React callbacks are scheduled on a special internal queue
    // 同步的React回调被安排在一个特殊的内部同步队列中
    callbackNode = scheduleSyncCallback(performSyncWorkOnRoot.bind(null, root));
  } else if (disableSchedulerTimeoutBasedOnReactExpirationTime) {
    callbackNode = scheduleCallback(
      priorityLevel,
      performConcurrentWorkOnRoot.bind(null, root),
    );
  } else {
    callbackNode = scheduleCallback(
      priorityLevel,
      performConcurrentWorkOnRoot.bind(null, root),
      // Compute a task timeout based on the expiration time.
      // 根据过期时间计算任务超时。
      // This also affects ordering because tasks are processed in timeout order.
      // 这也会影响排序，因为任务是按超时顺序处理的。
      {timeout: expirationTimeToMs(expirationTime) - now()},
    );
  }

  root.callbackNode = callbackNode;
}

// This is the entry point for every concurrent task, i.e. anything that
// goes through Scheduler.
function performConcurrentWorkOnRoot(root, didTimeout) {
  // Since we know we're in a React event, we can clear the current
  // event time. The next update will compute a new event time.
  currentEventTime = NoWork;

  if (didTimeout) {
    // The render task took too long to complete. Mark the current time as
    // expired to synchronously render all expired work in a single batch.
    const currentTime = requestCurrentTimeForUpdate();
    markRootExpiredAtTime(root, currentTime);
    // This will schedule a synchronous callback.
    ensureRootIsScheduled(root);
    return null;
  }

  // Determine the next expiration time to work on, using the fields stored
  // on the root.
  const expirationTime = getNextRootExpirationTimeToWorkOn(root);
  if (expirationTime !== NoWork) {
    const originalCallbackNode = root.callbackNode;
    invariant(
      (executionContext & (RenderContext | CommitContext)) === NoContext,
      'Should not already be working.',
    );

    flushPassiveEffects();

    // If the root or expiration time have changed, throw out the existing stack
    // and prepare a fresh one. Otherwise we'll continue where we left off.
    if (
      root !== workInProgressRoot ||
      expirationTime !== renderExpirationTime
    ) {
      prepareFreshStack(root, expirationTime);
      startWorkOnPendingInteractions(root, expirationTime);
    }

    // If we have a work-in-progress fiber, it means there's still work to do
    // in this root.
    if (workInProgress !== null) {
      const prevExecutionContext = executionContext;
      executionContext |= RenderContext;
      const prevDispatcher = pushDispatcher(root);
      const prevInteractions = pushInteractions(root);
      startWorkLoopTimer(workInProgress);
      do {
        try {
          workLoopConcurrent();
          break;
        } catch (thrownValue) {
          handleError(root, thrownValue);
        }
      } while (true);
      resetContextDependencies();
      executionContext = prevExecutionContext;
      popDispatcher(prevDispatcher);
      if (enableSchedulerTracing) {
        popInteractions(((prevInteractions: any): Set<Interaction>));
      }

      if (workInProgressRootExitStatus === RootFatalErrored) {
        const fatalError = workInProgressRootFatalError;
        stopInterruptedWorkLoopTimer();
        prepareFreshStack(root, expirationTime);
        markRootSuspendedAtTime(root, expirationTime);
        ensureRootIsScheduled(root);
        throw fatalError;
      }

      if (workInProgress !== null) {
        // There's still work left over. Exit without committing.
        stopInterruptedWorkLoopTimer();
      } else {
        // We now have a consistent tree. The next step is either to commit it,
        // or, if something suspended, wait to commit it after a timeout.
        stopFinishedWorkLoopTimer();

        const finishedWork: Fiber = ((root.finishedWork =
          root.current.alternate): any);
        root.finishedExpirationTime = expirationTime;
        finishConcurrentRender(
          root,
          finishedWork,
          workInProgressRootExitStatus,
          expirationTime,
        );
      }

      ensureRootIsScheduled(root);
      if (root.callbackNode === originalCallbackNode) {
        // The task node scheduled for this root is the same one that's
        // currently executed. Need to return a continuation.
        return performConcurrentWorkOnRoot.bind(null, root);
      }
    }
  }
  return null;
}

function finishConcurrentRender(
  root,
  finishedWork,
  exitStatus,
  expirationTime,
) {
  // Set this to null to indicate there's no in-progress render.
  workInProgressRoot = null;

  switch (exitStatus) {
    case RootIncomplete:
    case RootFatalErrored: {
      invariant(false, 'Root did not complete. This is a bug in React.');
    }
    // Flow knows about invariant, so it complains if I add a break
    // statement, but eslint doesn't know about invariant, so it complains
    // if I do. eslint-disable-next-line no-fallthrough
    case RootErrored: {
      // If this was an async render, the error may have happened due to
      // a mutation in a concurrent event. Try rendering one more time,
      // synchronously, to see if the error goes away. If there are
      // lower priority updates, let's include those, too, in case they
      // fix the inconsistency. Render at Idle to include all updates.
      // If it was Idle or Never or some not-yet-invented time, render
      // at that time.
      markRootExpiredAtTime(
        root,
        expirationTime > Idle ? Idle : expirationTime,
      );
      // We assume that this second render pass will be synchronous
      // and therefore not hit this path again.
      break;
    }
    case RootSuspended: {
      markRootSuspendedAtTime(root, expirationTime);
      const lastSuspendedTime = root.lastSuspendedTime;
      if (expirationTime === lastSuspendedTime) {
        root.nextKnownPendingLevel = getRemainingExpirationTime(finishedWork);
      }
      flushSuspensePriorityWarningInDEV();

      // We have an acceptable loading state. We need to figure out if we
      // should immediately commit it or wait a bit.

      // If we have processed new updates during this render, we may now
      // have a new loading state ready. We want to ensure that we commit
      // that as soon as possible.
      const hasNotProcessedNewUpdates =
        workInProgressRootLatestProcessedExpirationTime === Sync;
      if (
        hasNotProcessedNewUpdates &&
        // do not delay if we're inside an act() scope
        !(
          __DEV__ &&
          flushSuspenseFallbacksInTests &&
          IsThisRendererActing.current
        )
      ) {
        // If we have not processed any new updates during this pass, then
        // this is either a retry of an existing fallback state or a
        // hidden tree. Hidden trees shouldn't be batched with other work
        // and after that's fixed it can only be a retry. We're going to
        // throttle committing retries so that we don't show too many
        // loading states too quickly.
        let msUntilTimeout =
          globalMostRecentFallbackTime + FALLBACK_THROTTLE_MS - now();
        // Don't bother with a very short suspense time.
        if (msUntilTimeout > 10) {
          if (workInProgressRootHasPendingPing) {
            const lastPingedTime = root.lastPingedTime;
            if (lastPingedTime === NoWork || lastPingedTime >= expirationTime) {
              // This render was pinged but we didn't get to restart
              // earlier so try restarting now instead.
              root.lastPingedTime = expirationTime;
              prepareFreshStack(root, expirationTime);
              break;
            }
          }

          const nextTime = getNextRootExpirationTimeToWorkOn(root);
          if (nextTime !== NoWork && nextTime !== expirationTime) {
            // There's additional work on this root.
            break;
          }
          if (
            lastSuspendedTime !== NoWork &&
            lastSuspendedTime !== expirationTime
          ) {
            // We should prefer to render the fallback of at the last
            // suspended level. Ping the last suspended level to try
            // rendering it again.
            root.lastPingedTime = lastSuspendedTime;
            break;
          }

          // The render is suspended, it hasn't timed out, and there's no
          // lower priority work to do. Instead of committing the fallback
          // immediately, wait for more data to arrive.
          root.timeoutHandle = scheduleTimeout(
            commitRoot.bind(null, root),
            msUntilTimeout,
          );
          break;
        }
      }
      // The work expired. Commit immediately.
      commitRoot(root);
      break;
    }
    case RootSuspendedWithDelay: {
      markRootSuspendedAtTime(root, expirationTime);
      const lastSuspendedTime = root.lastSuspendedTime;
      if (expirationTime === lastSuspendedTime) {
        root.nextKnownPendingLevel = getRemainingExpirationTime(finishedWork);
      }
      flushSuspensePriorityWarningInDEV();

      if (
        // do not delay if we're inside an act() scope
        !(
          __DEV__ &&
          flushSuspenseFallbacksInTests &&
          IsThisRendererActing.current
        )
      ) {
        // We're suspended in a state that should be avoided. We'll try to
        // avoid committing it for as long as the timeouts let us.
        if (workInProgressRootHasPendingPing) {
          const lastPingedTime = root.lastPingedTime;
          if (lastPingedTime === NoWork || lastPingedTime >= expirationTime) {
            // This render was pinged but we didn't get to restart earlier
            // so try restarting now instead.
            root.lastPingedTime = expirationTime;
            prepareFreshStack(root, expirationTime);
            break;
          }
        }

        const nextTime = getNextRootExpirationTimeToWorkOn(root);
        if (nextTime !== NoWork && nextTime !== expirationTime) {
          // There's additional work on this root.
          break;
        }
        if (
          lastSuspendedTime !== NoWork &&
          lastSuspendedTime !== expirationTime
        ) {
          // We should prefer to render the fallback of at the last
          // suspended level. Ping the last suspended level to try
          // rendering it again.
          root.lastPingedTime = lastSuspendedTime;
          break;
        }

        let msUntilTimeout;
        if (workInProgressRootLatestSuspenseTimeout !== Sync) {
          // We have processed a suspense config whose expiration time we
          // can use as the timeout.
          msUntilTimeout =
            expirationTimeToMs(workInProgressRootLatestSuspenseTimeout) - now();
        } else if (workInProgressRootLatestProcessedExpirationTime === Sync) {
          // This should never normally happen because only new updates
          // cause delayed states, so we should have processed something.
          // However, this could also happen in an offscreen tree.
          msUntilTimeout = 0;
        } else {
          // If we don't have a suspense config, we're going to use a
          // heuristic to determine how long we can suspend.
          const eventTimeMs: number = inferTimeFromExpirationTime(
            workInProgressRootLatestProcessedExpirationTime,
          );
          const currentTimeMs = now();
          const timeUntilExpirationMs =
            expirationTimeToMs(expirationTime) - currentTimeMs;
          let timeElapsed = currentTimeMs - eventTimeMs;
          if (timeElapsed < 0) {
            // We get this wrong some time since we estimate the time.
            timeElapsed = 0;
          }

          msUntilTimeout = jnd(timeElapsed) - timeElapsed;

          // Clamp the timeout to the expiration time. TODO: Once the
          // event time is exact instead of inferred from expiration time
          // we don't need this.
          if (timeUntilExpirationMs < msUntilTimeout) {
            msUntilTimeout = timeUntilExpirationMs;
          }
        }

        // Don't bother with a very short suspense time.
        if (msUntilTimeout > 10) {
          // The render is suspended, it hasn't timed out, and there's no
          // lower priority work to do. Instead of committing the fallback
          // immediately, wait for more data to arrive.
          root.timeoutHandle = scheduleTimeout(
            commitRoot.bind(null, root),
            msUntilTimeout,
          );
          break;
        }
      }
      // The work expired. Commit immediately.
      commitRoot(root);
      break;
    }
    case RootCompleted: {
      // The work completed. Ready to commit.
      if (
        // do not delay if we're inside an act() scope
        !(
          __DEV__ &&
          flushSuspenseFallbacksInTests &&
          IsThisRendererActing.current
        ) &&
        workInProgressRootLatestProcessedExpirationTime !== Sync &&
        workInProgressRootCanSuspendUsingConfig !== null
      ) {
        // If we have exceeded the minimum loading delay, which probably
        // means we have shown a spinner already, we might have to suspend
        // a bit longer to ensure that the spinner is shown for
        // enough time.
        const msUntilTimeout = computeMsUntilSuspenseLoadingDelay(
          workInProgressRootLatestProcessedExpirationTime,
          expirationTime,
          workInProgressRootCanSuspendUsingConfig,
        );
        if (msUntilTimeout > 10) {
          markRootSuspendedAtTime(root, expirationTime);
          root.timeoutHandle = scheduleTimeout(
            commitRoot.bind(null, root),
            msUntilTimeout,
          );
          break;
        }
      }
      commitRoot(root);
      break;
    }
    default: {
      invariant(false, 'Unknown root exit status.');
    }
  }
}

// This is the entry point for synchronous tasks that don't go through Scheduler
// 这是不通过 Scheduler 的同步任务的入口点。
function performSyncWorkOnRoot(root) {
  // Check if there's expired work on this root. Otherwise, render at Sync.
  // 检查此根目录上是否有过期的工作。 否则，请在同步时渲染。
  const lastExpiredTime = root.lastExpiredTime;
  const expirationTime = lastExpiredTime !== NoWork ? lastExpiredTime : Sync;
  if (root.finishedExpirationTime === expirationTime) {
    // There's already a pending commit at this expiration time.
    // 在此到期时间已经有一个待处理的提交。
    // TODO: This is poorly factored. This case only exists for the
    // batch.commit() API.
    commitRoot(root);
  } else {
    invariant(
      (executionContext & (RenderContext | CommitContext)) === NoContext,
      'Should not already be working.',
    );

    flushPassiveEffects();

    // If the root or expiration time have changed, throw out the existing stack and prepare a fresh one. Otherwise we'll continue where we left off.
    // 如果根或到期时间已更改，则丢弃现有栈并准备新的栈。否则，我们将从中断的地方继续。
    if (
      root !== workInProgressRoot ||
      expirationTime !== renderExpirationTime
    ) {
      prepareFreshStack(root, expirationTime);
      startWorkOnPendingInteractions(root, expirationTime);
    }

    // If we have a work-in-progress fiber, it means there's still work to do in this root.
    // 如果我们有一个正在进行的 fiber ，则意味着在此根目录中仍有工作要做。
    if (workInProgress !== null) {
      const prevExecutionContext = executionContext;
      // 把执行栈设置为 RenderContext
      executionContext |= RenderContext;
      const prevDispatcher = pushDispatcher(root);
      const prevInteractions = pushInteractions(root);
      startWorkLoopTimer(workInProgress);

      /* ✨ */do {
      /* ✨ */  try {
      /* ✨ */    workLoopSync();
      /* ✨ */    break;
      /* ✨ */  } catch (thrownValue) {
      /* ✨ */    handleError(root, thrownValue);
      /* ✨ */  }
      /* ✨ */} while (true);

      // 到这里时，workInProgressRootExitStatus 的值为 RootCompleted

      resetContextDependencies();
      executionContext = prevExecutionContext;
      popDispatcher(prevDispatcher);
      if (enableSchedulerTracing) {
        popInteractions(prevInteractions);
      }

      if (workInProgressRootExitStatus === RootFatalErrored) {
        const fatalError = workInProgressRootFatalError;
        stopInterruptedWorkLoopTimer();
        prepareFreshStack(root, expirationTime);
        markRootSuspendedAtTime(root, expirationTime);
        ensureRootIsScheduled(root);
        throw fatalError;
      }

      if (workInProgress !== null) {
        // This is a sync render, so we should have finished the whole tree.
        // 这是一个同步渲染，所以我们应该完成整个树。
        invariant(
          false,
          'Cannot commit an incomplete root. This error is likely caused by a ' +
            'bug in React. Please file an issue.',
        );
      } else {
        // We now have a consistent tree. Because this is a sync render, we  will commit it even if something suspended.
        // 现在，我们有了一棵一致的树。 因为这是同步渲染，所以即使某些东西暂停，我们也将“提交”它。
        stopFinishedWorkLoopTimer();
        /* ✨ 把新树赋值到 finishedWork */root.finishedWork = (root.current.alternate: any);
        root.finishedExpirationTime = expirationTime;
        finishSyncRender(root, workInProgressRootExitStatus, expirationTime);
      }

      // Before exiting, make sure there's a callback scheduled for the next pending level.
      // 退出之前，请确保已为下一个未决级别安排了回调。
      ensureRootIsScheduled(root);
    }
  }

  return null;
}

function finishSyncRender(root, exitStatus, expirationTime) {
  // Set this to null to indicate there's no in-progress render.
  // 将此设置为null表示没有正在进行的渲染。
  workInProgressRoot = null;

  if (__DEV__) {
    if (exitStatus === RootSuspended || exitStatus === RootSuspendedWithDelay) {
      flushSuspensePriorityWarningInDEV();
    }
  }
  // 渲染阶段结束，开始进入提交阶段
  commitRoot(root);
}

export function flushRoot(root: FiberRoot, expirationTime: ExpirationTime) {
  markRootExpiredAtTime(root, expirationTime);
  ensureRootIsScheduled(root);
  if ((executionContext & (RenderContext | CommitContext)) === NoContext) {
    flushSyncCallbackQueue();
  }
}

// 搞定之前积攒的 DiscreteEvent与 useEffect 回调
export function flushDiscreteUpdates() {
  // TODO: Should be able to flush inside batchedUpdates, but not inside `act`.
  // However, `act` uses `batchedUpdates`, so there's no way to distinguish
  // those two cases. Need to fix this before exposing flushDiscreteUpdates
  // as a public API.
  if (
    (executionContext & (BatchedContext | RenderContext | CommitContext)) !==
    NoContext
  ) {
    if (__DEV__ && (executionContext & RenderContext) !== NoContext) {
      warning(
        false,
        'unstable_flushDiscreteUpdates: Cannot flush updates when React is ' +
          'already rendering.',
      );
    }
    // We're already rendering, so we can't synchronously flush pending work.
    // This is probably a nested event dispatch triggered by a lifecycle/effect,
    // like `el.focus()`. Exit.
    return;
  }
  flushPendingDiscreteUpdates();
  // If the discrete updates scheduled passive effects, flush them now so that they fire before the next serial event.
  // 如果离散更新计划了被动效果，请立即冲洗它们，以便它们在下一个串行事件之前触发。
  flushPassiveEffects();
}

export function deferredUpdates<A>(fn: () => A): A {
  // TODO: Remove in favor of Scheduler.next
  return runWithPriority(NormalPriority, fn);
}

export function syncUpdates<A, B, C, R>(
  fn: (A, B, C) => R,
  a: A,
  b: B,
  c: C,
): R {
  return runWithPriority(ImmediatePriority, fn.bind(null, a, b, c));
}

function flushPendingDiscreteUpdates() {
  if (rootsWithPendingDiscreteUpdates !== null) {
    // For each root with pending discrete updates, schedule a callback to
    // immediately flush them.
    const roots = rootsWithPendingDiscreteUpdates;
    rootsWithPendingDiscreteUpdates = null;
    roots.forEach((expirationTime, root) => {
      markRootExpiredAtTime(root, expirationTime);
      ensureRootIsScheduled(root);
    });
    // Now flush the immediate queue.
    flushSyncCallbackQueue();
  }
}

export function batchedUpdates<A, R>(fn: A => R, a: A): R {
  const prevExecutionContext = executionContext;
  executionContext |= BatchedContext;
  try {
    return fn(a);
  } finally {
    executionContext = prevExecutionContext;
    if (executionContext === NoContext) {
      // Flush the immediate callbacks that were scheduled during this batch
      flushSyncCallbackQueue();
    }
  }
}

export function batchedEventUpdates<A, R>(fn: A => R, a: A): R {
  const prevExecutionContext = executionContext;
  executionContext |= EventContext;
  try {
    return fn(a);
  } finally {
    executionContext = prevExecutionContext;
    if (executionContext === NoContext) {
      // Flush the immediate callbacks that were scheduled during this batch
      flushSyncCallbackQueue();
    }
  }
}

// 它会为React 的调度叠加一个 DiscreteEventContext 上下文，并执行 runWithPriority，
// 这时看来它与 dispatchUserBlockingUpdate 无异，只是做了一个前置处理。
export function discreteUpdates<A, B, C, R>(
  fn: (A, B, C) => R,
  a: A,
  b: B,
  c: C,
): R {
  const prevExecutionContext = executionContext;
  executionContext |= DiscreteEventContext;
  try {
    // Should this
    return runWithPriority(UserBlockingPriority, fn.bind(null, a, b, c));
  } finally {
    executionContext = prevExecutionContext;
    if (executionContext === NoContext) {
      // Flush the immediate callbacks that were scheduled during this batch
      flushSyncCallbackQueue();
    }
  }
}

// 不批量更新
// 在 LegacyUnbatchedContext 上下文中，执行函数 fn
export function unbatchedUpdates<A, R>(fn: (a: A) => R, a: A): R {
  // 当 React 的`执行上下文栈` 为 LegacyUnbatchedContext时，
  // 表示当前的更新是非分批渲染的(管你线程堵不堵塞，页面掉不掉帧，给我全部一起上)
  const prevExecutionContext = executionContext;
  executionContext &= ~BatchedContext;
  executionContext |= LegacyUnbatchedContext;
  try {
    return fn(a);
  } finally {
    executionContext = prevExecutionContext;
    if (executionContext === NoContext) {
      // Flush the immediate callbacks that were scheduled during this batch
      flushSyncCallbackQueue();
    }
  }
}

export function flushSync<A, R>(fn: A => R, a: A): R {
  if ((executionContext & (RenderContext | CommitContext)) !== NoContext) {
    invariant(
      false,
      'flushSync was called from inside a lifecycle method. It cannot be ' +
        'called when React is already rendering.',
    );
  }
  const prevExecutionContext = executionContext;
  executionContext |= BatchedContext;
  try {
    return runWithPriority(ImmediatePriority, fn.bind(null, a));
  } finally {
    executionContext = prevExecutionContext;
    // Flush the immediate callbacks that were scheduled during this batch.
    // Note that this will happen even if batchedUpdates is higher up
    // the stack.
    flushSyncCallbackQueue();
  }
}

export function flushControlled(fn: () => mixed): void {
  const prevExecutionContext = executionContext;
  executionContext |= BatchedContext;
  try {
    runWithPriority(ImmediatePriority, fn);
  } finally {
    executionContext = prevExecutionContext;
    if (executionContext === NoContext) {
      // Flush the immediate callbacks that were scheduled during this batch
      flushSyncCallbackQueue();
    }
  }
}

// 准备刷新栈
//taichiyi 准备创建另一颗树(workInProgress)
function prepareFreshStack(root, expirationTime) {
  root.finishedWork = null;
  root.finishedExpirationTime = NoWork;

  const timeoutHandle = root.timeoutHandle;
  if (timeoutHandle !== noTimeout) {
    // The root previous suspended and scheduled a timeout to commit a fallback state.
    // Now that we have additional work, cancel the timeout.
    // 根先前的节点暂停并计划了超时以提交回退状态。
    // 现在我们还有其他工作，请取消超时。
    root.timeoutHandle = noTimeout;
    // $FlowFixMe Complains noTimeout is not a TimeoutID, despite the check above
    cancelTimeout(timeoutHandle);
  }

  if (workInProgress !== null) {
    let interruptedWork = workInProgress.return;
    while (interruptedWork !== null) {
      unwindInterruptedWork(interruptedWork);
      interruptedWork = interruptedWork.return;
    }
  }
  workInProgressRoot = root;
  workInProgress = createWorkInProgress(root.current, null, expirationTime);
  renderExpirationTime = expirationTime;
  workInProgressRootExitStatus = RootIncomplete;
  workInProgressRootFatalError = null;
  workInProgressRootLatestProcessedExpirationTime = Sync;
  workInProgressRootLatestSuspenseTimeout = Sync;
  workInProgressRootCanSuspendUsingConfig = null;
  workInProgressRootNextUnprocessedUpdateTime = NoWork;
  workInProgressRootHasPendingPing = false;

  if (enableSchedulerTracing) {
    spawnedWorkDuringRender = null;
  }

  if (__DEV__) {
    ReactStrictModeWarnings.discardPendingWarnings();
    componentsThatTriggeredHighPriSuspend = null;
  }
}

function handleError(root, thrownValue) {
  do {
    try {
      // Reset module-level state that was set during the render phase.
      resetContextDependencies();
      resetHooks();
      resetCurrentDebugFiberInDEV();

      if (workInProgress === null || workInProgress.return === null) {
        // Expected to be working on a non-root fiber. This is a fatal error
        // because there's no ancestor that can handle it; the root is
        // supposed to capture all errors that weren't caught by an error
        // boundary.
        workInProgressRootExitStatus = RootFatalErrored;
        workInProgressRootFatalError = thrownValue;
        return null;
      }

      if (enableProfilerTimer && workInProgress.mode & ProfileMode) {
        // Record the time spent rendering before an error was thrown. This
        // avoids inaccurate Profiler durations in the case of a
        // suspended render.
        stopProfilerTimerIfRunningAndRecordDelta(workInProgress, true);
      }

      throwException(
        root,
        workInProgress.return,
        workInProgress,
        thrownValue,
        renderExpirationTime,
      );
      workInProgress = completeUnitOfWork(workInProgress);
    } catch (yetAnotherThrownValue) {
      // Something in the return path also threw.
      thrownValue = yetAnotherThrownValue;
      continue;
    }
    // Return to the normal work loop.
    return;
  } while (true);
}

function pushDispatcher(root) {
  const prevDispatcher = ReactCurrentDispatcher.current;
  ReactCurrentDispatcher.current = ContextOnlyDispatcher;
  if (prevDispatcher === null) {
    // The React isomorphic package does not include a default dispatcher.
    // React同构包不包括默认的调度程序。
    // Instead the first renderer will lazily attach one, in order to give nicer error messages.
    // 相反，第一个渲染器将延迟附加一个渲染器，以提供更好的错误消息。
    return ContextOnlyDispatcher;
  } else {
    return prevDispatcher;
  }
}

function popDispatcher(prevDispatcher) {
  ReactCurrentDispatcher.current = prevDispatcher;
}

function pushInteractions(root) {
  if (enableSchedulerTracing) {
    const prevInteractions: Set<Interaction> | null = __interactionsRef.current;
    __interactionsRef.current = root.memoizedInteractions;
    return prevInteractions;
  }
  return null;
}

function popInteractions(prevInteractions) {
  if (enableSchedulerTracing) {
    __interactionsRef.current = prevInteractions;
  }
}

export function markCommitTimeOfFallback() {
  globalMostRecentFallbackTime = now();
}

export function markRenderEventTimeAndConfig(
  expirationTime: ExpirationTime,
  suspenseConfig: null | SuspenseConfig,
): void {
  if (
    expirationTime < workInProgressRootLatestProcessedExpirationTime &&
    expirationTime > Idle
  ) {
    workInProgressRootLatestProcessedExpirationTime = expirationTime;
  }
  if (suspenseConfig !== null) {
    if (
      expirationTime < workInProgressRootLatestSuspenseTimeout &&
      expirationTime > Idle
    ) {
      workInProgressRootLatestSuspenseTimeout = expirationTime;
      // Most of the time we only have one config and getting wrong is not bad.
      workInProgressRootCanSuspendUsingConfig = suspenseConfig;
    }
  }
}

export function markUnprocessedUpdateTime(
  expirationTime: ExpirationTime,
): void {
  if (expirationTime > workInProgressRootNextUnprocessedUpdateTime) {
    workInProgressRootNextUnprocessedUpdateTime = expirationTime;
  }
}

export function renderDidSuspend(): void {
  if (workInProgressRootExitStatus === RootIncomplete) {
    workInProgressRootExitStatus = RootSuspended;
  }
}

export function renderDidSuspendDelayIfPossible(): void {
  if (
    workInProgressRootExitStatus === RootIncomplete ||
    workInProgressRootExitStatus === RootSuspended
  ) {
    workInProgressRootExitStatus = RootSuspendedWithDelay;
  }

  // Check if there's a lower priority update somewhere else in the tree.
  if (
    workInProgressRootNextUnprocessedUpdateTime !== NoWork &&
    workInProgressRoot !== null
  ) {
    // Mark the current render as suspended, and then mark that there's a
    // pending update.
    // TODO: This should immediately interrupt the current render, instead
    // of waiting until the next time we yield.
    markRootSuspendedAtTime(workInProgressRoot, renderExpirationTime);
    markRootUpdatedAtTime(
      workInProgressRoot,
      workInProgressRootNextUnprocessedUpdateTime,
    );
  }
}

export function renderDidError() {
  if (workInProgressRootExitStatus !== RootCompleted) {
    workInProgressRootExitStatus = RootErrored;
  }
}

// Called during render to determine if anything has suspended.
// Returns false if we're not sure.
export function renderHasNotSuspendedYet(): boolean {
  // If something errored or completed, we can't really be sure,
  // so those are false.
  return workInProgressRootExitStatus === RootIncomplete;
}

function inferTimeFromExpirationTime(expirationTime: ExpirationTime): number {
  // We don't know exactly when the update was scheduled, but we can infer an
  // approximate start time from the expiration time.
  const earliestExpirationTimeMs = expirationTimeToMs(expirationTime);
  return earliestExpirationTimeMs - LOW_PRIORITY_EXPIRATION;
}

function inferTimeFromExpirationTimeWithSuspenseConfig(
  expirationTime: ExpirationTime,
  suspenseConfig: SuspenseConfig,
): number {
  // We don't know exactly when the update was scheduled, but we can infer an
  // approximate start time from the expiration time by subtracting the timeout
  // that was added to the event time.
  const earliestExpirationTimeMs = expirationTimeToMs(expirationTime);
  return (
    earliestExpirationTimeMs -
    (suspenseConfig.timeoutMs | 0 || LOW_PRIORITY_EXPIRATION)
  );
}

// The work loop is an extremely hot path. Tell Closure not to inline it.
// 工作循环是一条非常热的路径。告诉 Closure 不要内联它。
/** @noinline */

// workInProgress 的 children 转为 fiber ,
function workLoopSync() {
  // Already timed out, so perform work without checking if we need to yield.
  // 已经超时，所以执行工作时不检查是否需要 yield 。
  while (workInProgress !== null) {
    workInProgress = performUnitOfWork(workInProgress);
  }
}

/** @noinline */
function workLoopConcurrent() {
  // Perform work until Scheduler asks us to yield
  while (workInProgress !== null && !shouldYield()) {
    workInProgress = performUnitOfWork(workInProgress);
  }
}

//taichiyi performUnitOfWork 方法接受 workInProgress 作为参数，同时调用 beginWork 方法。一个 fiber 节点的所有需要执行的处理都开始于这个方法。
function performUnitOfWork(unitOfWork: Fiber): Fiber | null {
  // The current, flushed, state of this fiber is the alternate.
  // Ideally nothing should rely on this,
  // but relying on it here means that we don't need an additional field on the work in progress.
  // 该 fiber 的当前刷新状态是备用状态。
  // 理想情况下，任何东西都不应该依赖于此，
  // 但是在这里依赖它意味着我们不需要关于正在进行的工作的额外字段。
  const current = unitOfWork.alternate;

  startWorkTimer(unitOfWork);
  setCurrentDebugFiberInDEV(unitOfWork);

  let next;
  if (enableProfilerTimer && (unitOfWork.mode & ProfileMode) !== NoMode) {
    startProfilerTimer(unitOfWork);
    next = beginWork(current, unitOfWork, renderExpirationTime);
    stopProfilerTimerIfRunningAndRecordDelta(unitOfWork, true);
  } else {
    next = beginWork(current, unitOfWork, renderExpirationTime);
  }

  resetCurrentDebugFiberInDEV();
  unitOfWork.memoizedProps = unitOfWork.pendingProps;
  if (next === null) {
    // If this doesn't spawn new work, complete the current work.
    // 如果这没有产生新 work ，请完成当前 work 。
    //taichiyi next 为 null 时，说明当前 fiber child 应该是为 null 的。
    next = completeUnitOfWork(unitOfWork);
  }

  ReactCurrentOwner.current = null;
  return next;
}

// 当 beginWork 函数的返回值为 null 时，说明 unitOfWork(workInProgress) child 为 null，就会进入此函数；
// 如果 workInProgress 有 sibling 时，则返回 sibling ;
// 没有 sibling , 则 workInProgress = returnFiber , 然后继续循环;
// 如果 workInProgress === null , 说明 fiber 树 已经...
function completeUnitOfWork(unitOfWork: Fiber): Fiber | null {
  // Attempt to complete the current unit of work, then move to the next sibling.
  // If there are no more siblings, return to the parent fiber.
  // 尝试完成当前工作单元，然后移动到下一个同级。
  // 如果没有更多的同级，则返回到父 fiber 。
  workInProgress = unitOfWork;
  //taichiyi 此时 workInProgress 的 child 为 null.
  do {
    // The current, flushed, state of this fiber is the alternate.
    // 该 fiber 的“当前”状态（刷新状态）为“ alternate”。
    // Ideally nothing should rely on this, but relying on it here means that we don't need an additional field on the work in progress.
    // 理想情况下，不应该依赖于此，但在这里依赖它意味着我们不需要在 work in progress 上增加字段。
    const current = workInProgress.alternate;
    const returnFiber = workInProgress.return;

    // Check if the work completed or if something threw.
    // 检查工作是否完成或是否有错误抛出。
    if ((workInProgress.effectTag & Incomplete) === NoEffect) {
      // 未完成
      setCurrentDebugFiberInDEV(workInProgress);
      let next;
      if (
        !enableProfilerTimer ||
        (workInProgress.mode & ProfileMode) === NoMode
      ) {
        next = completeWork(current, workInProgress, renderExpirationTime);
      } else {
        startProfilerTimer(workInProgress);
        next = completeWork(current, workInProgress, renderExpirationTime);
        // Update render duration assuming we didn't error.
        // 更新渲染持续时间，假设我们没有错误。
        stopProfilerTimerIfRunningAndRecordDelta(workInProgress, false);
      }
      stopWorkTimer(workInProgress);
      resetCurrentDebugFiberInDEV();
      resetChildExpirationTime(workInProgress);

      if (next !== null) {
        // Completing this fiber spawned new work. Work on that next.
        // 完成这个 fiber 产生了新的工作。 接下来继续工作。
        return next;
      }

      if (
        returnFiber !== null &&
        // Do not append effects to parents if a sibling failed to complete
        // 如果兄弟姐妹未能完成，请不要将效果附加到父对象
        (returnFiber.effectTag & Incomplete) === NoEffect
      ) {
        // Append all the effects of the subtree and this fiber onto the effect list of the parent.
        // 将子树和此 fiber 的所有效果附加到父级的效果列表中。
        // The completion order of the children affects the side-effect order.
        // 孩子的完成顺序会影响副作用的顺序。
        if (returnFiber.firstEffect === null) {
          returnFiber.firstEffect = workInProgress.firstEffect;
        }
        if (workInProgress.lastEffect !== null) {
          if (returnFiber.lastEffect !== null) {
            returnFiber.lastEffect.nextEffect = workInProgress.firstEffect;
          }
          returnFiber.lastEffect = workInProgress.lastEffect;
        }

        // If this fiber had side-effects, we append it AFTER the children's side-effects.
        // 如果这种 fiber 有副作用，我们会在孩子的副作用后附加它。
        // We can perform certain side-effects earlier if needed, by doing multiple passes over the effect list.
        // 如果需要，我们可以通过对 effect list 进行多次传递来更早地执行某些副作用。
        // We don't want to schedule our own side-effect on our own list because if end up reusing children we'll schedule this effect onto itself since we're at the end.
        // 我们不想在自己的列表上安排自己的副作用，因为如果最终重用了 children ，我们将在自己的末尾安排这种效果。
        const effectTag = workInProgress.effectTag;

        // Skip both NoWork and PerformedWork tags when creating the effect list.
        // 创建 effect list 时，请同时跳过NoWork和PerformedWork标签。
        // PerformedWork effect is read by React DevTools but shouldn't be committed.
        // PerformedWork效果由React DevTools读取，但不应提交。
        if (effectTag > PerformedWork) {
          if (returnFiber.lastEffect !== null) {
            returnFiber.lastEffect.nextEffect = workInProgress;
          } else {
            returnFiber.firstEffect = workInProgress;
          }
          returnFiber.lastEffect = workInProgress;
        }
      }
    } else {
      // This fiber did not complete because something threw.
      // 这个 fiber 没有完成，因为有东西抛出。
      // Pop values off the stack without entering the complete phase.
      // 在不进入完整阶段的情况下从栈中弹出值。
      // If this is a boundary, capture values if possible.
      // 如果这是一个边界，则尽可能捕获值。
      const next = unwindWork(workInProgress, renderExpirationTime);

      // Because this fiber did not complete, don't reset its expiration time.
      // 由于 fiber 未完成，请不要重置其过期时间。

      if (
        enableProfilerTimer &&
        (workInProgress.mode & ProfileMode) !== NoMode
      ) {
        // Record the render duration for the fiber that errored.
        // 记录出现错误的 fiber 的渲染时间。
        stopProfilerTimerIfRunningAndRecordDelta(workInProgress, false);

        // Include the time spent working on failed children before continuing.
        // 包括在继续工作之前为失败的孩子工作的时间。
        let actualDuration = workInProgress.actualDuration;
        let child = workInProgress.child;
        while (child !== null) {
          actualDuration += child.actualDuration;
          child = child.sibling;
        }
        workInProgress.actualDuration = actualDuration;
      }

      if (next !== null) {
        // If completing this work spawned new work, do that next. We'll come back here again.
        // 如果完成这项工作后又产生了新工作，请继续执行下一步。 我们会再次回到这里。
        // Since we're restarting, remove anything that is not a host effect from the effect tag.
        // 由于我们正在重新启动，请从 effect tag 中删除任何不是 host effect 的内容。
        // TODO: The name stopFailedWorkTimer is misleading because Suspense also captures and restarts.
        // TODO: stopFailedWorkTimer 的名称有误导性，因为Suspense也会捕获和重新启动。
        stopFailedWorkTimer(workInProgress);
        next.effectTag &= HostEffectMask;
        return next;
      }
      stopWorkTimer(workInProgress);

      if (returnFiber !== null) {
        // Mark the parent fiber as incomplete and clear its effect list.
        // 将父 fiber 标记为不完整，并清除其效果列表。
        returnFiber.firstEffect = returnFiber.lastEffect = null;
        returnFiber.effectTag |= Incomplete;
      }
    }

    const siblingFiber = workInProgress.sibling;
    if (siblingFiber !== null) {
      // If there is more work to do in this returnFiber, do that next.
      // 如果这根 returnFiber 还有更多的工作要做，那就下一步。
      return siblingFiber;
    }
    // Otherwise, return to the parent
    // 否则，返回父母
    workInProgress = returnFiber;
  } while (workInProgress !== null);

  // We've reached the root.
  // 我们已经到达了根。
  if (workInProgressRootExitStatus === RootIncomplete) {
    workInProgressRootExitStatus = RootCompleted;
  }
  return null;
}

function getRemainingExpirationTime(fiber: Fiber) {
  const updateExpirationTime = fiber.expirationTime;
  const childExpirationTime = fiber.childExpirationTime;
  return updateExpirationTime > childExpirationTime
    ? updateExpirationTime
    : childExpirationTime;
}

function resetChildExpirationTime(completedWork: Fiber) {
  if (
    renderExpirationTime !== Never &&
    completedWork.childExpirationTime === Never
  ) {
    // The children of this component are hidden. Don't bubble their
    // expiration times.
    return;
  }

  let newChildExpirationTime = NoWork;

  // Bubble up the earliest expiration time.
  if (enableProfilerTimer && (completedWork.mode & ProfileMode) !== NoMode) {
    // In profiling mode, resetChildExpirationTime is also used to reset
    // profiler durations.
    let actualDuration = completedWork.actualDuration;
    let treeBaseDuration = completedWork.selfBaseDuration;

    // When a fiber is cloned, its actualDuration is reset to 0. This value will
    // only be updated if work is done on the fiber (i.e. it doesn't bailout).
    // When work is done, it should bubble to the parent's actualDuration. If
    // the fiber has not been cloned though, (meaning no work was done), then
    // this value will reflect the amount of time spent working on a previous
    // render. In that case it should not bubble. We determine whether it was
    // cloned by comparing the child pointer.
    const shouldBubbleActualDurations =
      completedWork.alternate === null ||
      completedWork.child !== completedWork.alternate.child;

    let child = completedWork.child;
    while (child !== null) {
      const childUpdateExpirationTime = child.expirationTime;
      const childChildExpirationTime = child.childExpirationTime;
      if (childUpdateExpirationTime > newChildExpirationTime) {
        newChildExpirationTime = childUpdateExpirationTime;
      }
      if (childChildExpirationTime > newChildExpirationTime) {
        newChildExpirationTime = childChildExpirationTime;
      }
      if (shouldBubbleActualDurations) {
        actualDuration += child.actualDuration;
      }
      treeBaseDuration += child.treeBaseDuration;
      child = child.sibling;
    }
    completedWork.actualDuration = actualDuration;
    completedWork.treeBaseDuration = treeBaseDuration;
  } else {
    let child = completedWork.child;
    while (child !== null) {
      const childUpdateExpirationTime = child.expirationTime;
      const childChildExpirationTime = child.childExpirationTime;
      if (childUpdateExpirationTime > newChildExpirationTime) {
        newChildExpirationTime = childUpdateExpirationTime;
      }
      if (childChildExpirationTime > newChildExpirationTime) {
        newChildExpirationTime = childChildExpirationTime;
      }
      child = child.sibling;
    }
  }

  completedWork.childExpirationTime = newChildExpirationTime;
}

/**
 * shannon
 *
 * 在提交阶段运行的主函数是 commitRootImpl ，基本上它做了如下工作：
 *
 *
 * - 在标记 Snapshot  副作用的节点上调用 getSnapshotBeforeUpdate 生命周期方法。
 * - 在标记了 Deletion  副作用的节点上调用 componentWillUnmount 生命周期方法。
 * - 执行所有的 DOM 插入，更新，删除操作。
 * - 让 current指针指向  finishedWork 树。
 * - 在标记了 Placement 副作用的组件节点上调用 componentDidMount 生命周期方法。
 * - 在标记了 Update 副作用的组件节点上调用 componentDidUpdate 生命周期方法。
 *
 *
 * 在 getSnapshotBeforeUpdate 调用后，React 会提交整棵树的所有副作用。整个过程分为两步:
 * 1. 第一步执行 DOM 插入，更新，删除，ref 的卸载。接下来 React 将finishedWork 赋值给 FiberRoot ，并标记 workInProgress 树为  current 树。
 * 2. 这样做的原因是，第一步相当于是 componentWillUnmount 阶段，current指向之前的树，而接下里的第二步则相当于是 componentDidMount/Update 阶段，current要指向新树。
 *
 */
function commitRoot(root) {
  const renderPriorityLevel = getCurrentPriorityLevel();
  runWithPriority(
    ImmediatePriority,
    commitRootImpl.bind(null, root, renderPriorityLevel),
  );
  return null;
}

function commitRootImpl(root, renderPriorityLevel) {
  do {
    // `flushPassiveEffects` will call `flushSyncUpdateQueue` at the end, which means `flushPassiveEffects` will sometimes result in additional passive effects.
    // `flushPassiveEffects`将在最后调用`flushSyncUpdateQueue`，这意味着`flushPassiveEffects`有时会导致其他被动效果。
    // So we need to keep flushing in a loop until there are no more pending effects.
    // 所以我们需要在一个循环中不断刷新，直到没有更多的 pending effects。
    // TODO: Might be better if `flushPassiveEffects` did not automatically flush synchronous work at the end, to avoid factoring hazards like this.
    // TODO: 如果“flushPassiveEffects”在结束时不自动刷新同步工作，可能会更好，以避免像这样的风险。
    flushPassiveEffects();
  } while (rootWithPendingPassiveEffects !== null);
  flushRenderPhaseStrictModeWarningsInDEV();

  invariant(
    (executionContext & (RenderContext | CommitContext)) === NoContext,
    'Should not already be working.',
  );

  const finishedWork = root.finishedWork;
  const expirationTime = root.finishedExpirationTime;
  if (finishedWork === null) {
    return null;
  }
  root.finishedWork = null;
  root.finishedExpirationTime = NoWork;

  invariant(
    finishedWork !== root.current,
    'Cannot commit the same tree as before. This error is likely caused by ' +
      'a bug in React. Please file an issue.',
  );

  // commitRoot never returns a continuation; it always finishes synchronously.
  // commitRoot从不返回 continuation 。 它总是同步完成。
  // So we can clear these now to allow a new callback to be scheduled.
  // 所以我们现在可以清除这些，以便安排一个新的回调。
  root.callbackNode = null;
  root.callbackExpirationTime = NoWork;
  root.callbackPriority = NoPriority;
  root.nextKnownPendingLevel = NoWork;

  startCommitTimer();

  // Update the first and last pending times on this root.
  // 更新此根上的第一个和最后一个挂起时间。
  // The new first pending time is whatever is left on the root fiber.
  // 新的第一个 pending time 是 root fiber 上剩下的任何部分。
  const remainingExpirationTimeBeforeCommit = getRemainingExpirationTime(
    finishedWork,
  );
  markRootFinishedAtTime(
    root,
    expirationTime,
    remainingExpirationTimeBeforeCommit,
  );

  if (root === workInProgressRoot) {
    // We can reset these now that they are finished.
    // 现在就可以重置它们了。
    workInProgressRoot = null;
    workInProgress = null;
    renderExpirationTime = NoWork;
  } else {
    // This indicates that the last root we worked on is not the same one that we're committing now.
    // 这表明我们处理的最后一个根与我们现在提交的根不同。
    // This most commonly happens when a suspended root times out.
    // 这通常发生在挂起的根超时时。
  }

  // Get the list of effects.
  // 获取效果列表。
  let firstEffect;
  if (finishedWork.effectTag > PerformedWork) {
    // A fiber's effect list consists only of its children, not itself.
    // fiber 的效果列表只包含其子对象，而不包含其自身。
    // So if the root has an effect, we need to add it to the end of the list.
    // 因此，如果根目录有 effect，我们需要将其添加到列表的末尾。
    // The resulting list is the set that would belong to the root's parent, if it had one; that is, all the effects in the tree including the root.
    // 结果列表是根的父集（如果有的话）所属的集合。也就是说，树中的所有效果（包括根）。
    if (finishedWork.lastEffect !== null) {
      finishedWork.lastEffect.nextEffect = finishedWork;
      firstEffect = finishedWork.firstEffect;
    } else {
      firstEffect = finishedWork;
    }
  } else {
    // There is no effect on the root.
    firstEffect = finishedWork.firstEffect;
  }

  if (firstEffect !== null) {
    // 真正开始提交
    const prevExecutionContext = executionContext;
    executionContext |= CommitContext;
    const prevInteractions = pushInteractions(root);

    // Reset this to null before calling lifecycles
    // 在调用生命周期之前将其重置为null
    ReactCurrentOwner.current = null;

    // The commit phase is broken into several sub-phases.
    // 提交阶段分为几个子阶段。
    // We do a separate pass of the effect list for each phase: all mutation effects come before all layout effects, and so on.
    // 我们为每个阶段单独进行效果列表传递：所有 mutation 效果都在所有布局效果之前，依此类推。

    // The first phase a "before mutation" phase.
    // 第一阶段是"before mutation"阶段。
    // We use this phase to read the state of the host tree right before we mutate it.
    // 我们使用此阶段在对它进行 mutate 之前立即读取宿主树的状态。
    // This is where getSnapshotBeforeUpdate is called.
    // 这是调用 getSnapshotBeforeUpdate 的地方。
    startCommitSnapshotEffectsTimer();
    prepareForCommit(root.containerInfo);
    nextEffect = firstEffect;
    do {
      if (__DEV__) {
        invokeGuardedCallback(null, commitBeforeMutationEffects, null);
        if (hasCaughtError()) {
          invariant(nextEffect !== null, 'Should be working on an effect.');
          const error = clearCaughtError();
          captureCommitPhaseError(nextEffect, error);
          nextEffect = nextEffect.nextEffect;
        }
      } else {
        try {
          commitBeforeMutationEffects();
        } catch (error) {
          invariant(nextEffect !== null, 'Should be working on an effect.');
          captureCommitPhaseError(nextEffect, error);
          nextEffect = nextEffect.nextEffect;
        }
      }
    } while (nextEffect !== null);
    stopCommitSnapshotEffectsTimer();

    if (enableProfilerTimer) {
      // Mark the current commit time to be shared by all Profilers in this batch.
      // 标记当前提交时间，以供该批次中的所有Profiler共享。
      // This enables them to be grouped later.
      // 这使它们可以在以后分组。
      recordCommitTime();
    }

    // The next phase is the mutation phase, where we mutate the host tree.
    // 下一个阶段是 mutation 阶段，在此阶段，我们对 host 树进行 mutation 。
    startCommitHostEffectsTimer();
    nextEffect = firstEffect;
    do {
      if (__DEV__) {
        invokeGuardedCallback(
          null,
          commitMutationEffects,
          null,
          root,
          renderPriorityLevel,
        );
        if (hasCaughtError()) {
          invariant(nextEffect !== null, 'Should be working on an effect.');
          const error = clearCaughtError();
          captureCommitPhaseError(nextEffect, error);
          nextEffect = nextEffect.nextEffect;
        }
      } else {
        try {
          commitMutationEffects(root, renderPriorityLevel);
        } catch (error) {
          invariant(nextEffect !== null, 'Should be working on an effect.');
          captureCommitPhaseError(nextEffect, error);
          nextEffect = nextEffect.nextEffect;
        }
      }
    } while (nextEffect !== null);
    stopCommitHostEffectsTimer();
    resetAfterCommit(root.containerInfo);

    // The work-in-progress tree is now the current tree.
    // work-in-progress 树现在是当前树。
    // This must come after the mutation phase, so that the previous tree is still current during componentWillUnmount,
    // 这必须发生在 mutation 阶段之后，以便上一个树在 componentWillUnmount 期间仍然是当前树，
    // but before the layout phase, so that the finished work is current during componentDidMount/Update.
    // 但是在 layout phase 之前，以便在 componentDidMount / Update 期间完成的工作是 current 。
    /* ✨ 新树替换旧树 */root.current = finishedWork;

    // The next phase is the layout phase, where we call effects that read the host tree after it's been mutated.
    // 下一个阶段是 layout 阶段，在这个阶段中，我们调用在 host tree 发生变化后读取它的效果。
    // The idiomatic use case for this is layout, but class component lifecycles also fire here for legacy reasons.
    // 这方面的惯用用例是 layout ，但是由于遗留原因，类组件生命周期也在这里触发。
    startCommitLifeCyclesTimer();
    nextEffect = firstEffect;
    do {
      if (__DEV__) {
        invokeGuardedCallback(
          null,
          commitLayoutEffects,
          null,
          root,
          expirationTime,
        );
        if (hasCaughtError()) {
          invariant(nextEffect !== null, 'Should be working on an effect.');
          const error = clearCaughtError();
          captureCommitPhaseError(nextEffect, error);
          nextEffect = nextEffect.nextEffect;
        }
      } else {
        try {
          commitLayoutEffects(root, expirationTime);
        } catch (error) {
          invariant(nextEffect !== null, 'Should be working on an effect.');
          captureCommitPhaseError(nextEffect, error);
          nextEffect = nextEffect.nextEffect;
        }
      }
    } while (nextEffect !== null);
    stopCommitLifeCyclesTimer();

    nextEffect = null;

    // Tell Scheduler to yield at the end of the frame, so the browser has an opportunity to paint.
    // 告诉Scheduler在帧末尾 yield ，以便浏览器有机会绘画。
    requestPaint();

    if (enableSchedulerTracing) {
      popInteractions(prevInteractions);
    }
    executionContext = prevExecutionContext;
  } else {
    // No effects.
    /* ✨ 新树替换旧树 */root.current = finishedWork;
    // Measure these anyway so the flamegraph explicitly shows that there were no effects.
    // 无论如何都要进行测量，以便火焰图清楚地表明没有影响。
    // TODO: Maybe there's a better way to report this.
    // TODO：也许有更好的方法来报告此情况。
    startCommitSnapshotEffectsTimer();
    stopCommitSnapshotEffectsTimer();
    if (enableProfilerTimer) {
      recordCommitTime();
    }
    startCommitHostEffectsTimer();
    stopCommitHostEffectsTimer();
    startCommitLifeCyclesTimer();
    stopCommitLifeCyclesTimer();
  }

  stopCommitTimer();

  const rootDidHavePassiveEffects = rootDoesHavePassiveEffects;

  if (rootDoesHavePassiveEffects) {
    // This commit has passive effects.
    // 该提交具有被动效果。
    // Stash a reference to them.
    // 存放对它们的引用。
    // But don't schedule a callback until after flushing layout work.
    // 但是在刷新 layout work 之前不要安排回调。
    rootDoesHavePassiveEffects = false;
    rootWithPendingPassiveEffects = root;
    pendingPassiveEffectsExpirationTime = expirationTime;
    pendingPassiveEffectsRenderPriority = renderPriorityLevel;
  } else {
    // We are done with the effect chain at this point so let's clear the nextEffect pointers to assist with GC.
    // 至此，我们已经完成了效果链，因此让我们清除 nextEffect 指针以协助进行GC。
    // If we have passive effects, we'll clear this in flushPassiveEffects.
    // 如果我们有被动效果，我们将在 flushPassiveEffects 中清除它。
    nextEffect = firstEffect;
    while (nextEffect !== null) {
      const nextNextEffect = nextEffect.nextEffect;
      nextEffect.nextEffect = null;
      nextEffect = nextNextEffect;
    }
  }

  // Check if there's remaining work on this root
  // 检查此根上是否还有剩余工作
  const remainingExpirationTime = root.firstPendingTime;
  if (remainingExpirationTime !== NoWork) {
    if (enableSchedulerTracing) {
      if (spawnedWorkDuringRender !== null) {
        const expirationTimes = spawnedWorkDuringRender;
        spawnedWorkDuringRender = null;
        for (let i = 0; i < expirationTimes.length; i++) {
          scheduleInteractions(
            root,
            expirationTimes[i],
            root.memoizedInteractions,
          );
        }
      }
      schedulePendingInteractions(root, remainingExpirationTime);
    }
  } else {
    // If there's no remaining work, we can clear the set of already failed error boundaries.
    // 如果没有剩余的工作，我们可以清除已经失败的错误边界集。
    legacyErrorBoundariesThatAlreadyFailed = null;
  }

  if (enableSchedulerTracing) {
    if (!rootDidHavePassiveEffects) {
      // If there are no passive effects, then we can complete the pending interactions.
      // 如果没有 passive effects ，那么我们可以完成待处理的交互。
      // Otherwise, we'll wait until after the passive effects are flushed.
      // 否则，我们将等到 passive effects 被清除之后。
      // Wait to do this until after remaining work has been scheduled,
      // 等到剩下的工作 scheduled 后再做，
      // so that we don't prematurely signal complete for interactions when there's e.g. hidden work.
      // 所以当有隐藏的工作时，我们不会过早地发出信号，让交互完成。
      finishPendingInteractions(root, expirationTime);
    }
  }

  if (remainingExpirationTime === Sync) {
    // Count the number of times the root synchronously re-renders without finishing.
    // 计算根在未完成的情况下同步重新渲染的次数。
    // If there are too many, it indicates an infinite update loop.
    // 如果太多，则表示无限更新循环。
    if (root === rootWithNestedUpdates) {
      nestedUpdateCount++;
    } else {
      nestedUpdateCount = 0;
      rootWithNestedUpdates = root;
    }
  } else {
    nestedUpdateCount = 0;
  }

  onCommitRoot(finishedWork.stateNode, expirationTime);

  // Always call this before exiting `commitRoot`, to ensure that any additional work on this root is scheduled.
  // 总是在退出`commitRoot`之前调用它，以确保在此根目录上的任何其他工作都已 scheduled 。
  ensureRootIsScheduled(root);

  if (hasUncaughtError) {
    hasUncaughtError = false;
    const error = firstUncaughtError;
    firstUncaughtError = null;
    throw error;
  }

  if ((executionContext & LegacyUnbatchedContext) !== NoContext) {
    // 这种情况一般是 初次渲染

    // This is a legacy edge case.
    // 这是一个过时的边缘情况。
    // We just committed the initial mount of a ReactDOM.render-ed root inside of batchedUpdates.
    // 我们刚刚在 batchedUpdates 中提交了一个 ReactDOM.render-ed 根的初始安装。
    // The commit fired synchronously, but layout updates should be deferred until the end of the batch.
    // 提交是同步触发的，但是 layout 更新应推迟到批处理结束。
    return null;
  }

  // If layout work was scheduled, flush it now.
  // 如果 layout work 已 调度，请立即刷新。
  flushSyncCallbackQueue();
  return null;
}

function commitBeforeMutationEffects() {
  while (nextEffect !== null) {
    const effectTag = nextEffect.effectTag;
    if ((effectTag & Snapshot) !== NoEffect) {
      setCurrentDebugFiberInDEV(nextEffect);
      recordEffect();

      const current = nextEffect.alternate;
      commitBeforeMutationEffectOnFiber(current, nextEffect);

      resetCurrentDebugFiberInDEV();
    }
    if ((effectTag & Passive) !== NoEffect) {
      // If there are passive effects, schedule a callback to flush at the earliest opportunity.
      // 如果存在 passive effects ，请安排回调以尽早刷新。
      if (!rootDoesHavePassiveEffects) {
        rootDoesHavePassiveEffects = true;
        scheduleCallback(NormalPriority, () => {
          flushPassiveEffects();
          return null;
        });
      }
    }
    nextEffect = nextEffect.nextEffect;
  }
}

//taichiyi React 执行 DOM 更新使的是 commitMutationEffects 函数。
function commitMutationEffects(root: FiberRoot, renderPriorityLevel) {
  // TODO: Should probably move the bulk of this function to commitWork.
  // TODO: 可能应该将此功能的大部分移至 commitWork。
  while (nextEffect !== null) {
    setCurrentDebugFiberInDEV(nextEffect);

    const effectTag = nextEffect.effectTag;

    if (effectTag & ContentReset) {
      commitResetTextContent(nextEffect);
    }

    if (effectTag & Ref) {
      const current = nextEffect.alternate;
      if (current !== null) {
        commitDetachRef(current);
      }
    }

    // The following switch statement is only concerned about placement, updates, and deletions.
    // 下面的switch语句只关心 placement, updates, and deletions.
    // To avoid needing to add a case for every possible bitmap value, we remove the secondary effects from the effect tag and switch on that value.
    // 为了避免需要为每个可能的位图值添加大小写，我们从效果标签中删除了次要效果，然后打开该值。
    let primaryEffectTag =
      effectTag & (Placement | Update | Deletion | Hydrating);
    switch (primaryEffectTag) {
      case Placement: {
        commitPlacement(nextEffect);
        // Clear the "placement" from effect tag so that we know that this is inserted, before any life-cycles like componentDidMount gets called.
        // 从effect标签中清除 "placement" ，以便我们知道在调用诸如componentDidMount之类的任何生命周期之前已将其插入。
        // TODO: findDOMNode doesn't rely on this any more but isMounted does and isMounted is deprecated anyway so we should be able to kill this.
        // TODO：findDOMNode 不再依赖于此，但是 isMounted 依赖于此，并且 isMounted 无论如何都已弃用，因此我们应该可以杀死它。
        nextEffect.effectTag &= ~Placement;
        break;
      }
      case PlacementAndUpdate: {
        // Placement
        commitPlacement(nextEffect);
        // Clear the "placement" from effect tag so that we know that this is inserted, before any life-cycles like componentDidMount gets called.
        // 从effect标签中清除 "placement" ，以便我们知道在调用诸如componentDidMount之类的任何生命周期之前已将其插入。
        nextEffect.effectTag &= ~Placement;

        // Update
        const current = nextEffect.alternate;
        commitWork(current, nextEffect);
        break;
      }
      case Hydrating: {
        nextEffect.effectTag &= ~Hydrating;
        break;
      }
      case HydratingAndUpdate: {
        nextEffect.effectTag &= ~Hydrating;

        // Update
        const current = nextEffect.alternate;
        commitWork(current, nextEffect);
        break;
      }
      case Update: {
        const current = nextEffect.alternate;
        commitWork(current, nextEffect);
        break;
      }
      case Deletion: {
        commitDeletion(root, nextEffect, renderPriorityLevel);
        break;
      }
    }

    // TODO: Only record a mutation effect if primaryEffectTag is non-zero.
    recordEffect();

    resetCurrentDebugFiberInDEV();
    nextEffect = nextEffect.nextEffect;
  }
}

function commitLayoutEffects(
  root: FiberRoot,
  committedExpirationTime: ExpirationTime,
) {
  // TODO: Should probably move the bulk of this function to commitWork.
  // TODO: 可能应该将此功能的大部分移至 commitWork。
  while (nextEffect !== null) {
    setCurrentDebugFiberInDEV(nextEffect);

    const effectTag = nextEffect.effectTag;

    //taichiyi 副作用的类型 为`Update`或`Callback`
    if (effectTag & (Update | Callback)) {
      recordEffect();
      const current = nextEffect.alternate;
      commitLayoutEffectOnFiber(
        root,
        current,
        nextEffect,
        committedExpirationTime,
      );
    }

    //taichiyi 副作用的类型 为`Ref`
    if (effectTag & Ref) {
      recordEffect();
      commitAttachRef(nextEffect);
    }

    resetCurrentDebugFiberInDEV();
    nextEffect = nextEffect.nextEffect;
  }
}

export function flushPassiveEffects() {
  if (pendingPassiveEffectsRenderPriority !== NoPriority) {
    const priorityLevel =
      pendingPassiveEffectsRenderPriority > NormalPriority
        ? NormalPriority
        : pendingPassiveEffectsRenderPriority;
    pendingPassiveEffectsRenderPriority = NoPriority;
    return runWithPriority(priorityLevel, flushPassiveEffectsImpl);
  }
}

function flushPassiveEffectsImpl() {
  if (rootWithPendingPassiveEffects === null) {
    return false;
  }
  const root = rootWithPendingPassiveEffects;
  const expirationTime = pendingPassiveEffectsExpirationTime;
  rootWithPendingPassiveEffects = null;
  pendingPassiveEffectsExpirationTime = NoWork;

  invariant(
    (executionContext & (RenderContext | CommitContext)) === NoContext,
    'Cannot flush passive effects while already rendering.',
  );
  const prevExecutionContext = executionContext;
  // 执行上下文改为 CommitContext
  executionContext |= CommitContext;
  const prevInteractions = pushInteractions(root);

  // Note: This currently assumes there are no passive effects on the root fiber,
  // because the root is not part of its own effect list.
  // This could change in the future.
  // 注意：目前假设根 fiber 上没有被动效果，
  // 因为根不是其自身效果列表的一部分。
  // 这在未来可能会改变。
  let effect = root.current.firstEffect;
  while (effect !== null) {
    if (__DEV__) {
      setCurrentDebugFiberInDEV(effect);
      invokeGuardedCallback(null, commitPassiveHookEffects, null, effect);
      if (hasCaughtError()) {
        invariant(effect !== null, 'Should be working on an effect.');
        const error = clearCaughtError();
        captureCommitPhaseError(effect, error);
      }
      resetCurrentDebugFiberInDEV();
    } else {
      try {
        commitPassiveHookEffects(effect);
      } catch (error) {
        invariant(effect !== null, 'Should be working on an effect.');
        captureCommitPhaseError(effect, error);
      }
    }
    const nextNextEffect = effect.nextEffect;
    // Remove nextEffect pointer to assist GC
    // 删除nextEffect指针以协助GC
    effect.nextEffect = null;
    effect = nextNextEffect;
  }

  if (enableSchedulerTracing) {
    popInteractions(((prevInteractions: any): Set<Interaction>));
    finishPendingInteractions(root, expirationTime);
  }

  executionContext = prevExecutionContext;

  flushSyncCallbackQueue();

  // If additional passive effects were scheduled, increment a counter.
  // 如果计划了其他被动效果，请增加一个计数器。
  // If this exceeds the limit, we'll fire a warning.
  // 如果超过限制，我们将发出警告。
  nestedPassiveUpdateCount =
    rootWithPendingPassiveEffects === null ? 0 : nestedPassiveUpdateCount + 1;

  return true;
}

export function isAlreadyFailedLegacyErrorBoundary(instance: mixed): boolean {
  return (
    legacyErrorBoundariesThatAlreadyFailed !== null &&
    legacyErrorBoundariesThatAlreadyFailed.has(instance)
  );
}

export function markLegacyErrorBoundaryAsFailed(instance: mixed) {
  if (legacyErrorBoundariesThatAlreadyFailed === null) {
    legacyErrorBoundariesThatAlreadyFailed = new Set([instance]);
  } else {
    legacyErrorBoundariesThatAlreadyFailed.add(instance);
  }
}

function prepareToThrowUncaughtError(error: mixed) {
  if (!hasUncaughtError) {
    hasUncaughtError = true;
    firstUncaughtError = error;
  }
}
export const onUncaughtError = prepareToThrowUncaughtError;

function captureCommitPhaseErrorOnRoot(
  rootFiber: Fiber,
  sourceFiber: Fiber,
  error: mixed,
) {
  const errorInfo = createCapturedValue(error, sourceFiber);
  const update = createRootErrorUpdate(rootFiber, errorInfo, Sync);
  enqueueUpdate(rootFiber, update);
  const root = markUpdateTimeFromFiberToRoot(rootFiber, Sync);
  if (root !== null) {
    ensureRootIsScheduled(root);
    schedulePendingInteractions(root, Sync);
  }
}

export function captureCommitPhaseError(sourceFiber: Fiber, error: mixed) {
  if (sourceFiber.tag === HostRoot) {
    // Error was thrown at the root. There is no parent, so the root
    // itself should capture it.
    captureCommitPhaseErrorOnRoot(sourceFiber, sourceFiber, error);
    return;
  }

  let fiber = sourceFiber.return;
  while (fiber !== null) {
    if (fiber.tag === HostRoot) {
      captureCommitPhaseErrorOnRoot(fiber, sourceFiber, error);
      return;
    } else if (fiber.tag === ClassComponent) {
      const ctor = fiber.type;
      const instance = fiber.stateNode;
      if (
        typeof ctor.getDerivedStateFromError === 'function' ||
        (typeof instance.componentDidCatch === 'function' &&
          !isAlreadyFailedLegacyErrorBoundary(instance))
      ) {
        const errorInfo = createCapturedValue(error, sourceFiber);
        const update = createClassErrorUpdate(
          fiber,
          errorInfo,
          // TODO: This is always sync
          Sync,
        );
        enqueueUpdate(fiber, update);
        const root = markUpdateTimeFromFiberToRoot(fiber, Sync);
        if (root !== null) {
          ensureRootIsScheduled(root);
          schedulePendingInteractions(root, Sync);
        }
        return;
      }
    }
    fiber = fiber.return;
  }
}

export function pingSuspendedRoot(
  root: FiberRoot,
  thenable: Thenable,
  suspendedTime: ExpirationTime,
) {
  const pingCache = root.pingCache;
  if (pingCache !== null) {
    // The thenable resolved, so we no longer need to memoize, because it will
    // never be thrown again.
    pingCache.delete(thenable);
  }

  if (workInProgressRoot === root && renderExpirationTime === suspendedTime) {
    // Received a ping at the same priority level at which we're currently
    // rendering. We might want to restart this render. This should mirror
    // the logic of whether or not a root suspends once it completes.

    // TODO: If we're rendering sync either due to Sync, Batched or expired,
    // we should probably never restart.

    // If we're suspended with delay, we'll always suspend so we can always
    // restart. If we're suspended without any updates, it might be a retry.
    // If it's early in the retry we can restart. We can't know for sure
    // whether we'll eventually process an update during this render pass,
    // but it's somewhat unlikely that we get to a ping before that, since
    // getting to the root most update is usually very fast.
    if (
      workInProgressRootExitStatus === RootSuspendedWithDelay ||
      (workInProgressRootExitStatus === RootSuspended &&
        workInProgressRootLatestProcessedExpirationTime === Sync &&
        now() - globalMostRecentFallbackTime < FALLBACK_THROTTLE_MS)
    ) {
      // Restart from the root. Don't need to schedule a ping because
      // we're already working on this tree.
      prepareFreshStack(root, renderExpirationTime);
    } else {
      // Even though we can't restart right now, we might get an
      // opportunity later. So we mark this render as having a ping.
      workInProgressRootHasPendingPing = true;
    }
    return;
  }

  if (!isRootSuspendedAtTime(root, suspendedTime)) {
    // The root is no longer suspended at this time.
    return;
  }

  const lastPingedTime = root.lastPingedTime;
  if (lastPingedTime !== NoWork && lastPingedTime < suspendedTime) {
    // There's already a lower priority ping scheduled.
    return;
  }

  // Mark the time at which this ping was scheduled.
  root.lastPingedTime = suspendedTime;

  if (root.finishedExpirationTime === suspendedTime) {
    // If there's a pending fallback waiting to commit, throw it away.
    root.finishedExpirationTime = NoWork;
    root.finishedWork = null;
  }

  ensureRootIsScheduled(root);
  schedulePendingInteractions(root, suspendedTime);
}

function retryTimedOutBoundary(
  boundaryFiber: Fiber,
  retryTime: ExpirationTime,
) {
  // The boundary fiber (a Suspense component or SuspenseList component)
  // previously was rendered in its fallback state. One of the promises that
  // suspended it has resolved, which means at least part of the tree was
  // likely unblocked. Try rendering again, at a new expiration time.
  if (retryTime === NoWork) {
    const suspenseConfig = null; // Retries don't carry over the already committed update.
    const currentTime = requestCurrentTimeForUpdate();
    retryTime = computeExpirationForFiber(
      currentTime,
      boundaryFiber,
      suspenseConfig,
    );
  }
  // TODO: Special case idle priority?
  const root = markUpdateTimeFromFiberToRoot(boundaryFiber, retryTime);
  if (root !== null) {
    ensureRootIsScheduled(root);
    schedulePendingInteractions(root, retryTime);
  }
}

export function retryDehydratedSuspenseBoundary(boundaryFiber: Fiber) {
  const suspenseState: null | SuspenseState = boundaryFiber.memoizedState;
  let retryTime = NoWork;
  if (suspenseState !== null) {
    retryTime = suspenseState.retryTime;
  }
  retryTimedOutBoundary(boundaryFiber, retryTime);
}

export function resolveRetryThenable(boundaryFiber: Fiber, thenable: Thenable) {
  let retryTime = NoWork; // Default
  let retryCache: WeakSet<Thenable> | Set<Thenable> | null;
  if (enableSuspenseServerRenderer) {
    switch (boundaryFiber.tag) {
      case SuspenseComponent:
        retryCache = boundaryFiber.stateNode;
        const suspenseState: null | SuspenseState = boundaryFiber.memoizedState;
        if (suspenseState !== null) {
          retryTime = suspenseState.retryTime;
        }
        break;
      case SuspenseListComponent:
        retryCache = boundaryFiber.stateNode;
        break;
      default:
        invariant(
          false,
          'Pinged unknown suspense boundary type. ' +
            'This is probably a bug in React.',
        );
    }
  } else {
    retryCache = boundaryFiber.stateNode;
  }

  if (retryCache !== null) {
    // The thenable resolved, so we no longer need to memoize, because it will
    // never be thrown again.
    retryCache.delete(thenable);
  }

  retryTimedOutBoundary(boundaryFiber, retryTime);
}

// Computes the next Just Noticeable Difference (JND) boundary.
// The theory is that a person can't tell the difference between small differences in time.
// Therefore, if we wait a bit longer than necessary that won't translate to a noticeable
// difference in the experience. However, waiting for longer might mean that we can avoid
// showing an intermediate loading state. The longer we have already waited, the harder it
// is to tell small differences in time. Therefore, the longer we've already waited,
// the longer we can wait additionally. At some point we have to give up though.
// We pick a train model where the next boundary commits at a consistent schedule.
// These particular numbers are vague estimates. We expect to adjust them based on research.
function jnd(timeElapsed: number) {
  return timeElapsed < 120
    ? 120
    : timeElapsed < 480
      ? 480
      : timeElapsed < 1080
        ? 1080
        : timeElapsed < 1920
          ? 1920
          : timeElapsed < 3000
            ? 3000
            : timeElapsed < 4320
              ? 4320
              : ceil(timeElapsed / 1960) * 1960;
}

function computeMsUntilSuspenseLoadingDelay(
  mostRecentEventTime: ExpirationTime,
  committedExpirationTime: ExpirationTime,
  suspenseConfig: SuspenseConfig,
) {
  const busyMinDurationMs = (suspenseConfig.busyMinDurationMs: any) | 0;
  if (busyMinDurationMs <= 0) {
    return 0;
  }
  const busyDelayMs = (suspenseConfig.busyDelayMs: any) | 0;

  // Compute the time until this render pass would expire.
  const currentTimeMs: number = now();
  const eventTimeMs: number = inferTimeFromExpirationTimeWithSuspenseConfig(
    mostRecentEventTime,
    suspenseConfig,
  );
  const timeElapsed = currentTimeMs - eventTimeMs;
  if (timeElapsed <= busyDelayMs) {
    // If we haven't yet waited longer than the initial delay, we don't
    // have to wait any additional time.
    return 0;
  }
  const msUntilTimeout = busyDelayMs + busyMinDurationMs - timeElapsed;
  // This is the value that is passed to `setTimeout`.
  return msUntilTimeout;
}

function checkForNestedUpdates() {
  if (nestedUpdateCount > NESTED_UPDATE_LIMIT) {
    nestedUpdateCount = 0;
    rootWithNestedUpdates = null;
    invariant(
      false,
      'Maximum update depth exceeded. This can happen when a component ' +
        'repeatedly calls setState inside componentWillUpdate or ' +
        'componentDidUpdate. React limits the number of nested updates to ' +
        'prevent infinite loops.',
    );
  }

  if (__DEV__) {
    if (nestedPassiveUpdateCount > NESTED_PASSIVE_UPDATE_LIMIT) {
      nestedPassiveUpdateCount = 0;
      warning(
        false,
        'Maximum update depth exceeded. This can happen when a component ' +
          "calls setState inside useEffect, but useEffect either doesn't " +
          'have a dependency array, or one of the dependencies changes on ' +
          'every render.',
      );
    }
  }
}

function flushRenderPhaseStrictModeWarningsInDEV() {
  if (__DEV__) {
    ReactStrictModeWarnings.flushLegacyContextWarning();

    if (warnAboutDeprecatedLifecycles) {
      ReactStrictModeWarnings.flushPendingUnsafeLifecycleWarnings();
    }
  }
}

function stopFinishedWorkLoopTimer() {
  const didCompleteRoot = true;
  stopWorkLoopTimer(interruptedBy, didCompleteRoot);
  interruptedBy = null;
}

function stopInterruptedWorkLoopTimer() {
  // TODO: Track which fiber caused the interruption.
  const didCompleteRoot = false;
  stopWorkLoopTimer(interruptedBy, didCompleteRoot);
  interruptedBy = null;
}

function checkForInterruption(
  fiberThatReceivedUpdate: Fiber,
  updateExpirationTime: ExpirationTime,
) {
  if (
    enableUserTimingAPI &&
    workInProgressRoot !== null &&
    updateExpirationTime > renderExpirationTime
  ) {
    interruptedBy = fiberThatReceivedUpdate;
  }
}

let didWarnStateUpdateForUnmountedComponent: Set<string> | null = null;
function warnAboutUpdateOnUnmountedFiberInDEV(fiber) {
  if (__DEV__) {
    const tag = fiber.tag;
    if (
      tag !== HostRoot &&
      tag !== ClassComponent &&
      tag !== FunctionComponent &&
      tag !== ForwardRef &&
      tag !== MemoComponent &&
      tag !== SimpleMemoComponent
    ) {
      // Only warn for user-defined components, not internal ones like Suspense.
      return;
    }
    // We show the whole stack but dedupe on the top component's name because
    // the problematic code almost always lies inside that component.
    const componentName = getComponentName(fiber.type) || 'ReactComponent';
    if (didWarnStateUpdateForUnmountedComponent !== null) {
      if (didWarnStateUpdateForUnmountedComponent.has(componentName)) {
        return;
      }
      didWarnStateUpdateForUnmountedComponent.add(componentName);
    } else {
      didWarnStateUpdateForUnmountedComponent = new Set([componentName]);
    }
    warningWithoutStack(
      false,
      "Can't perform a React state update on an unmounted component. This " +
        'is a no-op, but it indicates a memory leak in your application. To ' +
        'fix, cancel all subscriptions and asynchronous tasks in %s.%s',
      tag === ClassComponent
        ? 'the componentWillUnmount method'
        : 'a useEffect cleanup function',
      getStackByFiberInDevAndProd(fiber),
    );
  }
}

let beginWork;
if (__DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback) {
  let dummyFiber = null;
  beginWork = (current, unitOfWork, expirationTime) => {
    // If a component throws an error, we replay it again in a synchronously
    // dispatched event, so that the debugger will treat it as an uncaught
    // error See ReactErrorUtils for more information.

    // Before entering the begin phase, copy the work-in-progress onto a dummy
    // fiber. If beginWork throws, we'll use this to reset the state.
    const originalWorkInProgressCopy = assignFiberPropertiesInDEV(
      dummyFiber,
      unitOfWork,
    );
    try {
      return originalBeginWork(current, unitOfWork, expirationTime);
    } catch (originalError) {
      if (
        originalError !== null &&
        typeof originalError === 'object' &&
        typeof originalError.then === 'function'
      ) {
        // Don't replay promises. Treat everything else like an error.
        throw originalError;
      }

      // Keep this code in sync with handleError; any changes here must have
      // corresponding changes there.
      resetContextDependencies();
      resetHooks();
      // Don't reset current debug fiber, since we're about to work on the
      // same fiber again.

      // Unwind the failed stack frame
      unwindInterruptedWork(unitOfWork);

      // Restore the original properties of the fiber.
      assignFiberPropertiesInDEV(unitOfWork, originalWorkInProgressCopy);

      if (enableProfilerTimer && unitOfWork.mode & ProfileMode) {
        // Reset the profiler timer.
        startProfilerTimer(unitOfWork);
      }

      // Run beginWork again.
      invokeGuardedCallback(
        null,
        originalBeginWork,
        null,
        current,
        unitOfWork,
        expirationTime,
      );

      if (hasCaughtError()) {
        const replayError = clearCaughtError();
        // `invokeGuardedCallback` sometimes sets an expando `_suppressLogging`.
        // Rethrow this error instead of the original one.
        throw replayError;
      } else {
        // This branch is reachable if the render phase is impure.
        throw originalError;
      }
    }
  };
} else {
  beginWork = originalBeginWork;
}

let didWarnAboutUpdateInRender = false;
let didWarnAboutUpdateInGetChildContext = false;
function warnAboutInvalidUpdatesOnClassComponentsInDEV(fiber) {
  if (__DEV__) {
    if (fiber.tag === ClassComponent) {
      switch (ReactCurrentDebugFiberPhaseInDEV) {
        case 'getChildContext':
          if (didWarnAboutUpdateInGetChildContext) {
            return;
          }
          warningWithoutStack(
            false,
            'setState(...): Cannot call setState() inside getChildContext()',
          );
          didWarnAboutUpdateInGetChildContext = true;
          break;
        case 'render':
          if (didWarnAboutUpdateInRender) {
            return;
          }
          warningWithoutStack(
            false,
            'Cannot update during an existing state transition (such as ' +
              'within `render`). Render methods should be a pure function of ' +
              'props and state.',
          );
          didWarnAboutUpdateInRender = true;
          break;
      }
    }
  }
}

// a 'shared' variable that changes when act() opens/closes in tests.
export const IsThisRendererActing = {current: (false: boolean)};

export function warnIfNotScopedWithMatchingAct(fiber: Fiber): void {
  if (__DEV__) {
    if (
      warnsIfNotActing === true &&
      IsSomeRendererActing.current === true &&
      IsThisRendererActing.current !== true
    ) {
      warningWithoutStack(
        false,
        "It looks like you're using the wrong act() around your test interactions.\n" +
          'Be sure to use the matching version of act() corresponding to your renderer:\n\n' +
          '// for react-dom:\n' +
          "import {act} from 'react-dom/test-utils';\n" +
          '// ...\n' +
          'act(() => ...);\n\n' +
          '// for react-test-renderer:\n' +
          "import TestRenderer from 'react-test-renderer';\n" +
          'const {act} = TestRenderer;\n' +
          '// ...\n' +
          'act(() => ...);' +
          '%s',
        getStackByFiberInDevAndProd(fiber),
      );
    }
  }
}

export function warnIfNotCurrentlyActingEffectsInDEV(fiber: Fiber): void {
  if (__DEV__) {
    if (
      warnsIfNotActing === true &&
      (fiber.mode & StrictMode) !== NoMode &&
      IsSomeRendererActing.current === false &&
      IsThisRendererActing.current === false
    ) {
      warningWithoutStack(
        false,
        'An update to %s ran an effect, but was not wrapped in act(...).\n\n' +
          'When testing, code that causes React state updates should be ' +
          'wrapped into act(...):\n\n' +
          'act(() => {\n' +
          '  /* fire events that update state */\n' +
          '});\n' +
          '/* assert on the output */\n\n' +
          "This ensures that you're testing the behavior the user would see " +
          'in the browser.' +
          ' Learn more at https://fb.me/react-wrap-tests-with-act' +
          '%s',
        getComponentName(fiber.type),
        getStackByFiberInDevAndProd(fiber),
      );
    }
  }
}

function warnIfNotCurrentlyActingUpdatesInDEV(fiber: Fiber): void {
  if (__DEV__) {
    if (
      warnsIfNotActing === true &&
      executionContext === NoContext &&
      IsSomeRendererActing.current === false &&
      IsThisRendererActing.current === false
    ) {
      warningWithoutStack(
        false,
        'An update to %s inside a test was not wrapped in act(...).\n\n' +
          'When testing, code that causes React state updates should be ' +
          'wrapped into act(...):\n\n' +
          'act(() => {\n' +
          '  /* fire events that update state */\n' +
          '});\n' +
          '/* assert on the output */\n\n' +
          "This ensures that you're testing the behavior the user would see " +
          'in the browser.' +
          ' Learn more at https://fb.me/react-wrap-tests-with-act' +
          '%s',
        getComponentName(fiber.type),
        getStackByFiberInDevAndProd(fiber),
      );
    }
  }
}

export const warnIfNotCurrentlyActingUpdatesInDev = warnIfNotCurrentlyActingUpdatesInDEV;

// In tests, we want to enforce a mocked scheduler.
let didWarnAboutUnmockedScheduler = false;
// TODO Before we release concurrent mode, revisit this and decide whether a mocked
// scheduler is the actual recommendation. The alternative could be a testing build,
// a new lib, or whatever; we dunno just yet. This message is for early adopters
// to get their tests right.

export function warnIfUnmockedScheduler(fiber: Fiber) {
  if (__DEV__) {
    if (
      didWarnAboutUnmockedScheduler === false &&
      Scheduler.unstable_flushAllWithoutAsserting === undefined
    ) {
      if (fiber.mode & BlockingMode || fiber.mode & ConcurrentMode) {
        didWarnAboutUnmockedScheduler = true;
        warningWithoutStack(
          false,
          'In Concurrent or Sync modes, the "scheduler" module needs to be mocked ' +
            'to guarantee consistent behaviour across tests and browsers. ' +
            'For example, with jest: \n' +
            "jest.mock('scheduler', () => require('scheduler/unstable_mock'));\n\n" +
            'For more info, visit https://fb.me/react-mock-scheduler',
        );
      } else if (warnAboutUnmockedScheduler === true) {
        didWarnAboutUnmockedScheduler = true;
        warningWithoutStack(
          false,
          'Starting from React v17, the "scheduler" module will need to be mocked ' +
            'to guarantee consistent behaviour across tests and browsers. ' +
            'For example, with jest: \n' +
            "jest.mock('scheduler', () => require('scheduler/unstable_mock'));\n\n" +
            'For more info, visit https://fb.me/react-mock-scheduler',
        );
      }
    }
  }
}

let componentsThatTriggeredHighPriSuspend = null;
export function checkForWrongSuspensePriorityInDEV(sourceFiber: Fiber) {
  if (__DEV__) {
    const currentPriorityLevel = getCurrentPriorityLevel();
    if (
      (sourceFiber.mode & ConcurrentMode) !== NoEffect &&
      (currentPriorityLevel === UserBlockingPriority ||
        currentPriorityLevel === ImmediatePriority)
    ) {
      let workInProgressNode = sourceFiber;
      while (workInProgressNode !== null) {
        // Add the component that triggered the suspense
        const current = workInProgressNode.alternate;
        if (current !== null) {
          // TODO: warn component that triggers the high priority
          // suspend is the HostRoot
          switch (workInProgressNode.tag) {
            case ClassComponent:
              // Loop through the component's update queue and see whether the component
              // has triggered any high priority updates
              const updateQueue = current.updateQueue;
              if (updateQueue !== null) {
                let update = updateQueue.firstUpdate;
                while (update !== null) {
                  const priorityLevel = update.priority;
                  if (
                    priorityLevel === UserBlockingPriority ||
                    priorityLevel === ImmediatePriority
                  ) {
                    if (componentsThatTriggeredHighPriSuspend === null) {
                      componentsThatTriggeredHighPriSuspend = new Set([
                        getComponentName(workInProgressNode.type),
                      ]);
                    } else {
                      componentsThatTriggeredHighPriSuspend.add(
                        getComponentName(workInProgressNode.type),
                      );
                    }
                    break;
                  }
                  update = update.next;
                }
              }
              break;
            case FunctionComponent:
            case ForwardRef:
            case SimpleMemoComponent:
              if (
                workInProgressNode.memoizedState !== null &&
                workInProgressNode.memoizedState.baseUpdate !== null
              ) {
                let update = workInProgressNode.memoizedState.baseUpdate;
                // Loop through the functional component's memoized state to see whether
                // the component has triggered any high pri updates
                while (update !== null) {
                  const priority = update.priority;
                  if (
                    priority === UserBlockingPriority ||
                    priority === ImmediatePriority
                  ) {
                    if (componentsThatTriggeredHighPriSuspend === null) {
                      componentsThatTriggeredHighPriSuspend = new Set([
                        getComponentName(workInProgressNode.type),
                      ]);
                    } else {
                      componentsThatTriggeredHighPriSuspend.add(
                        getComponentName(workInProgressNode.type),
                      );
                    }
                    break;
                  }
                  if (
                    update.next === workInProgressNode.memoizedState.baseUpdate
                  ) {
                    break;
                  }
                  update = update.next;
                }
              }
              break;
            default:
              break;
          }
        }
        workInProgressNode = workInProgressNode.return;
      }
    }
  }
}

function flushSuspensePriorityWarningInDEV() {
  if (__DEV__) {
    if (componentsThatTriggeredHighPriSuspend !== null) {
      const componentNames = [];
      componentsThatTriggeredHighPriSuspend.forEach(name =>
        componentNames.push(name),
      );
      componentsThatTriggeredHighPriSuspend = null;

      if (componentNames.length > 0) {
        warningWithoutStack(
          false,
          '%s triggered a user-blocking update that suspended.' +
            '\n\n' +
            'The fix is to split the update into multiple parts: a user-blocking ' +
            'update to provide immediate feedback, and another update that ' +
            'triggers the bulk of the changes.' +
            '\n\n' +
            'Refer to the documentation for useTransition to learn how ' +
            'to implement this pattern.',
          // TODO: Add link to React docs with more information, once it exists
          componentNames.sort().join(', '),
        );
      }
    }
  }
}

function computeThreadID(root, expirationTime) {
  // Interaction threads are unique per root and expiration time.
  return expirationTime * 1000 + root.interactionThreadID;
}

export function markSpawnedWork(expirationTime: ExpirationTime) {
  if (!enableSchedulerTracing) {
    return;
  }
  if (spawnedWorkDuringRender === null) {
    spawnedWorkDuringRender = [expirationTime];
  } else {
    spawnedWorkDuringRender.push(expirationTime);
  }
}

function scheduleInteractions(root, expirationTime, interactions) {
  if (!enableSchedulerTracing) {
    return;
  }

  if (interactions.size > 0) {
    const pendingInteractionMap = root.pendingInteractionMap;
    const pendingInteractions = pendingInteractionMap.get(expirationTime);
    if (pendingInteractions != null) {
      // 遍历并更新还未调度的同步任务的数量
      interactions.forEach(interaction => {
        if (!pendingInteractions.has(interaction)) {
          // Update the pending async work count for previously unscheduled interaction.
          interaction.__count++;
        }

        pendingInteractions.add(interaction);
      });
    } else {
      pendingInteractionMap.set(expirationTime, new Set(interactions));

      // Update the pending async work count for the current interactions.
      interactions.forEach(interaction => {
        interaction.__count++;
      });
    }

    const subscriber = __subscriberRef.current;
    if (subscriber !== null) {
      const threadID = computeThreadID(root, expirationTime);
      subscriber.onWorkScheduled(interactions, threadID);
    }
  }
}

function schedulePendingInteractions(root, expirationTime) {
  // This is called when work is scheduled on a root.
  // 在根目录上安排工作时将调用此方法。
  // It associates the current interactions with the newly-scheduled expiration.
  // 它将当前交互与新计划的到期时间相关联。
  // They will be restored when that expiration is later committed.
  // 它们将在以后到期时恢复。
  if (!enableSchedulerTracing) {
    return;
  }

  scheduleInteractions(root, expirationTime, __interactionsRef.current);
}

function startWorkOnPendingInteractions(root, expirationTime) {
  // This is called when new work is started on a root.
  // 在 root 上开始新 work 时将调用此函数。
  if (!enableSchedulerTracing) {
    return;
  }

  // Determine which interactions this batch of work currently includes,
  // So that we can accurately attribute time spent working on it,
  // And so that cascading work triggered during the render phase will be associated with it.
  // 确定这批 work 当前包括哪些交互，
  // 以便我们可以准确地确定处理它所花费的时间，
  // 以便在渲染阶段触发的级联 work 与其关联。
  const interactions: Set<Interaction> = new Set();
  root.pendingInteractionMap.forEach(
    (scheduledInteractions, scheduledExpirationTime) => {
      if (scheduledExpirationTime >= expirationTime) {
        scheduledInteractions.forEach(interaction =>
          interactions.add(interaction),
        );
      }
    },
  );

  // Store the current set of interactions on the FiberRoot for a few reasons:
  // We can re-use it in hot functions like performConcurrentWorkOnRoot()
  // without having to recalculate it. We will also use it in commitWork() to
  // pass to any Profiler onRender() hooks. This also provides DevTools with a
  // way to access it when the onCommitRoot() hook is called.
  root.memoizedInteractions = interactions;

  if (interactions.size > 0) {
    const subscriber = __subscriberRef.current;
    if (subscriber !== null) {
      const threadID = computeThreadID(root, expirationTime);
      try {
        subscriber.onWorkStarted(interactions, threadID);
      } catch (error) {
        // If the subscriber throws, rethrow it in a separate task
        scheduleCallback(ImmediatePriority, () => {
          throw error;
        });
      }
    }
  }
}

function finishPendingInteractions(root, committedExpirationTime) {
  if (!enableSchedulerTracing) {
    return;
  }

  const earliestRemainingTimeAfterCommit = root.firstPendingTime;

  let subscriber;

  try {
    subscriber = __subscriberRef.current;
    if (subscriber !== null && root.memoizedInteractions.size > 0) {
      const threadID = computeThreadID(root, committedExpirationTime);
      subscriber.onWorkStopped(root.memoizedInteractions, threadID);
    }
  } catch (error) {
    // If the subscriber throws, rethrow it in a separate task
    scheduleCallback(ImmediatePriority, () => {
      throw error;
    });
  } finally {
    // Clear completed interactions from the pending Map.
    // Unless the render was suspended or cascading work was scheduled,
    // In which case– leave pending interactions until the subsequent render.
    const pendingInteractionMap = root.pendingInteractionMap;
    pendingInteractionMap.forEach(
      (scheduledInteractions, scheduledExpirationTime) => {
        // Only decrement the pending interaction count if we're done.
        // If there's still work at the current priority,
        // That indicates that we are waiting for suspense data.
        if (scheduledExpirationTime > earliestRemainingTimeAfterCommit) {
          pendingInteractionMap.delete(scheduledExpirationTime);

          scheduledInteractions.forEach(interaction => {
            interaction.__count--;

            if (subscriber !== null && interaction.__count === 0) {
              try {
                subscriber.onInteractionScheduledWorkCompleted(interaction);
              } catch (error) {
                // If the subscriber throws, rethrow it in a separate task
                scheduleCallback(ImmediatePriority, () => {
                  throw error;
                });
              }
            }
          });
        }
      },
    );
  }
}
