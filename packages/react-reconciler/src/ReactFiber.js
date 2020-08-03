/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactElement, Source} from 'shared/ReactElementType';
import type {
  ReactFragment,
  ReactPortal,
  RefObject,
  ReactEventResponder,
  ReactEventResponderInstance,
  ReactFundamentalComponent,
  ReactScope,
} from 'shared/ReactTypes';
import type {RootTag} from 'shared/ReactRootTags';
import type {WorkTag} from 'shared/ReactWorkTags';
import type {TypeOfMode} from './ReactTypeOfMode';
import type {SideEffectTag} from 'shared/ReactSideEffectTags';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {UpdateQueue} from './ReactUpdateQueue';
import type {ContextDependency} from './ReactFiberNewContext';
import type {HookType} from './ReactFiberHooks';
import type {SuspenseInstance} from './ReactFiberHostConfig';

import invariant from 'shared/invariant';
import warningWithoutStack from 'shared/warningWithoutStack';
import {
  enableProfilerTimer,
  enableFundamentalAPI,
  enableUserTimingAPI,
  enableScopeAPI,
} from 'shared/ReactFeatureFlags';
import {NoEffect, Placement} from 'shared/ReactSideEffectTags';
import {ConcurrentRoot, BlockingRoot} from 'shared/ReactRootTags';
import {
  IndeterminateComponent,
  ClassComponent,
  HostRoot,
  HostComponent,
  HostText,
  HostPortal,
  ForwardRef,
  Fragment,
  Mode,
  ContextProvider,
  ContextConsumer,
  Profiler,
  SuspenseComponent,
  SuspenseListComponent,
  DehydratedFragment,
  FunctionComponent,
  MemoComponent,
  SimpleMemoComponent,
  LazyComponent,
  FundamentalComponent,
  ScopeComponent,
} from 'shared/ReactWorkTags';
import getComponentName from 'shared/getComponentName';

import {isDevToolsPresent} from './ReactFiberDevToolsHook';
import {
  resolveClassForHotReloading,
  resolveFunctionForHotReloading,
  resolveForwardRefForHotReloading,
} from './ReactFiberHotReloading';
import {NoWork} from './ReactFiberExpirationTime';
import {
  NoMode,
  ConcurrentMode,
  ProfileMode,
  StrictMode,
  BlockingMode,
} from './ReactTypeOfMode';
import {
  REACT_FORWARD_REF_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_STRICT_MODE_TYPE,
  REACT_PROFILER_TYPE,
  REACT_PROVIDER_TYPE,
  REACT_CONTEXT_TYPE,
  REACT_CONCURRENT_MODE_TYPE,
  REACT_SUSPENSE_TYPE,
  REACT_SUSPENSE_LIST_TYPE,
  REACT_MEMO_TYPE,
  REACT_LAZY_TYPE,
  REACT_FUNDAMENTAL_TYPE,
  REACT_SCOPE_TYPE,
} from 'shared/ReactSymbols';

let hasBadMapPolyfill;

if (__DEV__) {
  hasBadMapPolyfill = false;
  try {
    const nonExtensibleObject = Object.preventExtensions({});
    const testMap = new Map([[nonExtensibleObject, null]]);
    const testSet = new Set([nonExtensibleObject]);
    // This is necessary for Rollup to not consider these unused.
    // https://github.com/rollup/rollup/issues/1771
    // TODO: we can remove these if Rollup fixes the bug.
    testMap.set(0, 0);
    testSet.add(0);
  } catch (e) {
    // TODO: Consider warning about bad polyfills
    hasBadMapPolyfill = true;
  }
}

export type Dependencies = {
  expirationTime: ExpirationTime,
  firstContext: ContextDependency<mixed> | null,
  responders: Map<
    ReactEventResponder<any, any>,
    ReactEventResponderInstance<any, any>,
  > | null,
};

// A Fiber is work on a Component that needs to be done or was done.
// There can be more than one per component.
// Fiber 是指在需要或已经完成的部件上的 work。
// 每个组件可以有多个。
export type Fiber = {|
  // These first fields are conceptually members of an Instance.
  // This used to be split into a separate type and intersected with the other Fiber fields,
  // but until Flow fixes its intersection bugs, we've merged them into a single type.
  // 这些第一个字段在概念上是实例的成员。
  // 这曾经被拆分为单独的类型，并与其他 fiber 字段相交，
  // 但在 Flow 修复其交集 Bug 之前，我们将它们合并为单个类型。

  // An Instance is shared between all versions of a component.
  // We can easily break this out into a separate object to avoid copying so much to the alternate versions of the tree.
  // We put this on a single object for now to minimize the number of objects created during the initial render.
  // 实例在组件的所有版本之间共享。
  // 我们可以很容易地将其分解到一个单独的对象中，以避免将太多内容复制到树的备用版本中。
  // 我们现在将其放在单个对象上，以最大限度地减少在初始渲染期间创建的对象数量。

  // Tag identifying the type of fiber.
  // 用 tag 标识 fiber 的类型。
  tag: WorkTag,

  // Unique identifier of this child.
  // 此子项的唯一标识符。
  key: null | string,

  // The value of element.type which is used to preserve the identity during reconciliation of this child.
  // element.type 的值，用于在此子级协调期间保留标识。
  elementType: any,

  // The resolved function/class/ associated with this fiber.
  // 已解析的与此 fiber 关联的 函数/类/。
  type: any,

  // The local state associated with this fiber.
  // 与此 fiber 关联的本地状态。
  stateNode: any,

  // Conceptual aliases
  // parent : Instance -> return The parent happens to be the same as the
  // return fiber since we've merged the fiber and instance.

  // Remaining fields belong to Fiber

  // The Fiber to return to after finishing processing this one.
  // 完成处理后返回的 fiber 。
  // This is effectively the parent, but there can be multiple parents (two) so this is only the parent of the thing we're currently processing.
  // 这实际上是 parent ，但可能有多个父（两个），因此这只是我们当前正在处理对象的父对象。
  // It is conceptually the same as the return address of a stack frame.
  // 从概念上讲，它与栈帧的返回地址相同。
  return: Fiber | null,

  // Singly Linked List Tree Structure.
  // 单链表树结构。
  child: Fiber | null,
  sibling: Fiber | null,
  index: number,

  // The ref last used to attach this node.
  // I'll avoid adding an owner field for prod and model that as functions.
  ref: null | (((handle: mixed) => void) & {_stringRef: ?string}) | RefObject,

  // Input is the data coming into process this fiber. Arguments. Props.
  // 输入是进入 fiber 处理的数据。Arguments。Props。
  pendingProps: any, // This type will be more specific once we overload the tag. 一旦我们重载标记，这种类型将更加具体。
  memoizedProps: any, // The props used to create the output.

  // A queue of state updates and callbacks.
  updateQueue: UpdateQueue<any> | null,

  // The state used to create the output
  memoizedState: any,

  // Dependencies (contexts, events) for this fiber, if it has any
  dependencies: Dependencies | null,

  // Bitfield that describes properties about the fiber and its subtree.
  // E.g. the ConcurrentMode flag indicates whether the subtree should be async-by-default.
  // When a fiber is created, it inherits the mode of its parent.
  // Additional flags can be set at creation time, but after that the value should remain unchanged throughout the fiber's lifetime, particularly before its child fibers are created.
  // 描述 fiber 及其子树属性的位域。
  // 例如，ConcurrentMode标志指示子树在默认情况下是否应该是异步的。
  // 创建 fiber 时，它继承其父 fiber 的模式。
  // 可以在创建时设置其他标志，但在此之后，该值应在 fiber 的整个生命周期内保持不变，特别是在创建子 fiber 之前。
  mode: TypeOfMode,

  // Effect
  effectTag: SideEffectTag,

  // Singly linked list fast path to the next fiber with side-effects.
  // 单链表快速路径到下一个 fiber 与副作用。
  nextEffect: Fiber | null,

  // The first and last fiber with side-effect within this subtree.
  // This allows us to reuse a slice of the linked list when we reuse the work done within this fiber.
  // 第一个也是最后一个在子树内有副作用的 fiber 。
  // 这使我们能够重用链表中的一个切片，当我们重用在此 fiber 中完成的 work。
  firstEffect: Fiber | null,
  lastEffect: Fiber | null,

  // Represents a time in the future by which this work should be completed.
  // Does not include work found in its subtree.
  // 表示将来应完成此 work 的时间。
  // 不包括在其子树中找到的 work 。
  expirationTime: ExpirationTime,

  // This is used to quickly determine if a subtree has no pending changes.
  // 这用于快速确定子树是否没有挂起的更改。
  childExpirationTime: ExpirationTime,

  // This is a pooled version of a Fiber.
  // Every fiber that gets updated will eventually have a pair.
  // There are cases when we can clean up pairs to save memory if we need to.
  // 这是 fiber 的汇总版本。
  // 每个更新的 fiber 最终都会有一对。
  // 在某些情况下，我们可以清理配对以节省内存。
  alternate: Fiber | null,

  // Time spent rendering this Fiber and its descendants for the current update.
  // 为当前更新渲染此 fiber 及其子代所花费的时间。
  // This tells us how well the tree makes use of sCU for memoization.
  // 这告诉我们树使用sCU进行记忆的程度。
  // It is reset to 0 each time we render and only updated when we don't bailout.
  // 每次渲染时，它将重置为0，并且仅在不进行紧急救援时才更新。
  // This field is only set when the enableProfilerTimer flag is enabled.
  // 此字段仅在启用enableProfilerTimer标志时设置。
  actualDuration?: number,

  // If the Fiber is currently active in the "render" phase,
  // 如果 fiber 当前在“渲染”阶段处于活动状态，
  // This marks the time at which the work began.
  // This field is only set when the enableProfilerTimer flag is enabled.
  // 此字段仅在启用enableProfilerTimer标志时设置。
  actualStartTime?: number,

  // Duration of the most recent render time for this Fiber.
  // This value is not updated when we bailout for memoization purposes.
  // This field is only set when the enableProfilerTimer flag is enabled.
  // 此字段仅在启用enableProfilerTimer标志时设置。
  selfBaseDuration?: number,

  // Sum of base times for all descendants of this Fiber.
  // This value bubbles up during the "complete" phase.
  // This field is only set when the enableProfilerTimer flag is enabled.
  // 此字段仅在启用enableProfilerTimer标志时设置。
  treeBaseDuration?: number,

  // Conceptual aliases
  // workInProgress : Fiber ->  alternate The alternate used for reuse happens
  // to be the same as work in progress.
  // __DEV__ only
  _debugID?: number,
  _debugSource?: Source | null,
  _debugOwner?: Fiber | null,
  _debugIsCurrentlyTiming?: boolean,
  _debugNeedsRemount?: boolean,

  // Used to verify that the order of hooks does not change between renders.
  _debugHookTypes?: Array<HookType> | null,
|};

let debugCounter = 1;

//taichiyi Fiber node 结构
function FiberNode(
  tag: WorkTag,
  pendingProps: mixed,
  key: null | string,
  mode: TypeOfMode,
) {
  // Instance

  // 标记不同的组件类型
  this.tag = tag;
  // ReactElement里面的key
  // 相同层级孩子节点唯一标记，可以优化提升 React 对子节点更新，添加，删处的判断效率。
  // 与它具体功能相关的官方文档可以看这里。https://zh-hans.reactjs.org/docs/lists-and-keys.html#keys
  this.key = key;
  // ReactElement.type，也就是我们调用`createElement`的第一个参数
  this.elementType = null;
  // 定义了与该 fiber node 相对应的是一个函数组件还是一个类组件。如果是一个类组件该属性指向这个类的构造函数。
  // 如果是一个 DOM 元素，该属性则是与之相对应的 HTML 标签。使用这个域很容易就能理解与该 fiber 节点相关联的元素是什么。
  this.type = null;
  // The resolved function/class/ associated with this fiber.
  // 异步组件resolved之后返回的内容，一般是`function`或者`class`
  // 用于保存类组件的实例，宿主组件的 DOM 实例等。通常我们也可以说这个属性是用来保存与该 fiber 相对应的的本地状态。
  this.stateNode = null;

  // Fiber

  // 指向他在Fiber节点树中的`parent`，用来在处理完这个节点之后向上返回
  this.return = null;
  // 单链表树结构
  // 指向自己的第一个子节点
  this.child = null;
  // 指向自己的兄弟结构
  // 兄弟节点的return指向同一个父节点
  this.sibling = null;
  this.index = 0;

  // ref属性
  this.ref = null;

  // 新的变动带来的新的props
  // 保存着最近一次从 render 方法返回的 React Element 中拿到的数据，等待随后被应用到子组件或是 DOM 元素上。
  this.pendingProps = pendingProps;
  // 上一次渲染完成之后的props
  // 已经使用渲染过的 fiber 属性，也是构成当前屏幕 UI  状态映射的一部分。
  this.memoizedProps = null;
  // 该Fiber对应的组件产生的Update会存放在这个队列里面
  // 一个state更新队列，包括回调 和 DOM 更新。
  this.updateQueue = null;
  // 上一次渲染的时候的state
  // 已经被使用渲染的过的 fiber 状态。也就是当前屏幕上 UI  状态的映射。
  this.memoizedState = null;
  this.dependencies = null;

  // 用来描述当前Fiber和他子树的`Bitfield`
  // 共存的模式表示这个子树是否默认是异步渲染的
  // Fiber被创建的时候他会继承父Fiber
  // 其他的标识也可以在创建的时候被设置
  // 但是在创建之后不应该再被修改，特别是他的子Fiber创建之前
  this.mode = mode;

  // Effects

  // 用来记录Side Effect
  // 副作用的类型，如：新增、删除
  this.effectTag = NoEffect;
  // 单链表用来快速查找下一个side effect
  this.nextEffect = null;

  // 子树中第一个side effect
  this.firstEffect = null;
  // 子树中最后一个side effect
  this.lastEffect = null;

  // 代表任务在未来的哪个时间点应该被完成
  // 不包括他的子树产生的任务
  this.expirationTime = NoWork;
  // 快速确定子树中是否有不在等待的变化
  this.childExpirationTime = NoWork;

  // 在Fiber树更新的过程中，每个Fiber都会有一个跟其对应的Fiber
  // 我们称他为`current <==> workInProgress`
  // 在渲染完成之后他们会交换位置
  this.alternate = null;

  if (enableProfilerTimer) {
    // Note: The following is done to avoid a v8 performance cliff.
    //
    // Initializing the fields below to smis and later updating them with
    // double values will cause Fibers to end up having separate shapes.
    // This behavior/bug has something to do with Object.preventExtension().
    // Fortunately this only impacts DEV builds.
    // Unfortunately it makes React unusably slow for some applications.
    // To work around this, initialize the fields below with doubles.
    //
    // Learn more about this here:
    // https://github.com/facebook/react/issues/14365
    // https://bugs.chromium.org/p/v8/issues/detail?id=8538
    this.actualDuration = Number.NaN;
    this.actualStartTime = Number.NaN;
    this.selfBaseDuration = Number.NaN;
    this.treeBaseDuration = Number.NaN;

    // It's okay to replace the initial doubles with smis after initialization.
    // This won't trigger the performance cliff mentioned above,
    // and it simplifies other profiler code (including DevTools).
    this.actualDuration = 0;
    this.actualStartTime = -1;
    this.selfBaseDuration = 0;
    this.treeBaseDuration = 0;
  }

  // This is normally DEV-only except www when it adds listeners.
  // TODO: remove the User Timing integration in favor of Root Events.
  if (enableUserTimingAPI) {
    this._debugID = debugCounter++;
    this._debugIsCurrentlyTiming = false;
  }

  if (__DEV__) {
    this._debugSource = null;
    this._debugOwner = null;
    this._debugNeedsRemount = false;
    this._debugHookTypes = null;
    if (!hasBadMapPolyfill && typeof Object.preventExtensions === 'function') {
      Object.preventExtensions(this);
    }
  }
}

// This is a constructor function, rather than a POJO constructor, still please ensure we do the following:
// 这是一个构造函数，而不是POJO构造函数，请确保我们执行以下操作：
// 1) Nobody should add any instance methods on this.
//    没人应该为此添加任何实例方法。
//    Instance methods can be more difficult to predict when they get optimized and they are almost never inlined properly in static compilers.
//    优化实例方法时，很难预测它们，并且在静态编译器中几乎永远不会正确地插入它们。
// 2) Nobody should rely on `instanceof Fiber` for type testing. We should always know when it is a fiber.
//    没有人应该依靠`instanceof Fiber`进行类型测试。我们应该始终知道它何时是 fiber 。
// 3) We might want to experiment with using numeric keys since they are easier to optimize in a non-JIT environment.
//    我们可能想尝试使用数字键，因为它们在非JIT环境中更容易优化。
// 4) We can easily go from a constructor to a createFiber object literal if that is faster.
//    如果这样更快的话，我们可以很容易地从构造函数转到createFibre对象文字。
// 5) It should be easy to port this to a C struct and keep a C implementation compatible.
//    将其移植到C结构并保持C实现兼容应该很容易。

const createFiber = function(
  tag: WorkTag,
  pendingProps: mixed,
  key: null | string,
  mode: TypeOfMode,
): Fiber {
  // $FlowFixMe: the shapes are exact here but Flow doesn't like constructors
  return new FiberNode(tag, pendingProps, key, mode);
};

// 判断是否为 ClassComponent
function shouldConstruct(Component: Function) {
  const prototype = Component.prototype;
  return !!(prototype && prototype.isReactComponent);
}

export function isSimpleFunctionComponent(type: any) {
  return (
    typeof type === 'function' &&
    !shouldConstruct(type) &&
    type.defaultProps === undefined
  );
}

export function resolveLazyComponentTag(Component: Function): WorkTag {
  if (typeof Component === 'function') {
    return shouldConstruct(Component) ? ClassComponent : FunctionComponent;
  } else if (Component !== undefined && Component !== null) {
    const $$typeof = Component.$$typeof;
    if ($$typeof === REACT_FORWARD_REF_TYPE) {
      return ForwardRef;
    }
    if ($$typeof === REACT_MEMO_TYPE) {
      return MemoComponent;
    }
  }
  return IndeterminateComponent;
}

// This is used to create an alternate fiber to do work on.
// 这是用来创造一个 alternate fiber 做工作。
export function createWorkInProgress(
  current: Fiber,
  pendingProps: any,
  expirationTime: ExpirationTime,
): Fiber {
  let workInProgress = current.alternate;
  if (workInProgress === null) {
    // We use a double buffering pooling technique because we know that we'll only ever need at most two versions of a tree.
    // We pool the "other" unused node that we're free to reuse.
    // This is lazily created to avoid allocating extra objects for things that are never updated.
    // It also allow us to reclaim the extra memory if needed.
    // 我们使用✨双缓冲✨池技术，因为我们知道一棵树最多只需要两个版本。
    // 可以自由重用的“其他”未使用节点。
    // 惰性地创建它是为了避免为从未更新的对象分配额外的对象。
    // 它还允许我们在需要时回收额外的内存。

    workInProgress = createFiber(
      current.tag,
      pendingProps,
      current.key,
      current.mode,
    );
    workInProgress.elementType = current.elementType;
    workInProgress.type = current.type;
    workInProgress.stateNode = current.stateNode;

    if (__DEV__) {
      // DEV-only fields
      workInProgress._debugID = current._debugID;
      workInProgress._debugSource = current._debugSource;
      workInProgress._debugOwner = current._debugOwner;
      workInProgress._debugHookTypes = current._debugHookTypes;
    }

    workInProgress.alternate = current;
    current.alternate = workInProgress;
  } else {
    workInProgress.pendingProps = pendingProps;

    // We already have an alternate.
    // Reset the effect tag.
    workInProgress.effectTag = NoEffect;

    // The effect list is no longer valid.
    workInProgress.nextEffect = null;
    workInProgress.firstEffect = null;
    workInProgress.lastEffect = null;

    if (enableProfilerTimer) {
      // We intentionally reset, rather than copy, actualDuration & actualStartTime.
      // This prevents time from endlessly accumulating in new commits.
      // This has the downside of resetting values for different priority renders,
      // But works for yielding (the common case) and should support resuming.
      workInProgress.actualDuration = 0;
      workInProgress.actualStartTime = -1;
    }
  }

  workInProgress.childExpirationTime = current.childExpirationTime;
  workInProgress.expirationTime = current.expirationTime;

  workInProgress.child = current.child;
  workInProgress.memoizedProps = current.memoizedProps;
  workInProgress.memoizedState = current.memoizedState;
  workInProgress.updateQueue = current.updateQueue;

  // Clone the dependencies object.
  // This is mutated during the render phase, so it cannot be shared with the current fiber.
  // 克隆依赖项对象。
  // 这在渲染阶段会发生变化，因此不能与当前 fiber 共享。
  const currentDependencies = current.dependencies;
  workInProgress.dependencies =
    currentDependencies === null
      ? null
      : {
          expirationTime: currentDependencies.expirationTime,
          firstContext: currentDependencies.firstContext,
          responders: currentDependencies.responders,
        };

  // These will be overridden during the parent's reconciliation
  // 这些将在父级的“协调”期间被覆盖
  workInProgress.sibling = current.sibling;
  workInProgress.index = current.index;
  workInProgress.ref = current.ref;

  if (enableProfilerTimer) {
    workInProgress.selfBaseDuration = current.selfBaseDuration;
    workInProgress.treeBaseDuration = current.treeBaseDuration;
  }

  if (__DEV__) {
    workInProgress._debugNeedsRemount = current._debugNeedsRemount;
    switch (workInProgress.tag) {
      case IndeterminateComponent:
      case FunctionComponent:
      case SimpleMemoComponent:
        workInProgress.type = resolveFunctionForHotReloading(current.type);
        break;
      case ClassComponent:
        workInProgress.type = resolveClassForHotReloading(current.type);
        break;
      case ForwardRef:
        workInProgress.type = resolveForwardRefForHotReloading(current.type);
        break;
      default:
        break;
    }
  }

  return workInProgress;
}

// Used to reuse a Fiber for a second pass.
export function resetWorkInProgress(
  workInProgress: Fiber,
  renderExpirationTime: ExpirationTime,
) {
  // This resets the Fiber to what createFiber or createWorkInProgress would
  // have set the values to before during the first pass. Ideally this wouldn't
  // be necessary but unfortunately many code paths reads from the workInProgress
  // when they should be reading from current and writing to workInProgress.

  // We assume pendingProps, index, key, ref, return are still untouched to
  // avoid doing another reconciliation.

  // Reset the effect tag but keep any Placement tags, since that's something
  // that child fiber is setting, not the reconciliation.
  workInProgress.effectTag &= Placement;

  // The effect list is no longer valid.
  workInProgress.nextEffect = null;
  workInProgress.firstEffect = null;
  workInProgress.lastEffect = null;

  let current = workInProgress.alternate;
  if (current === null) {
    // Reset to createFiber's initial values.
    workInProgress.childExpirationTime = NoWork;
    workInProgress.expirationTime = renderExpirationTime;

    workInProgress.child = null;
    workInProgress.memoizedProps = null;
    workInProgress.memoizedState = null;
    workInProgress.updateQueue = null;

    workInProgress.dependencies = null;

    if (enableProfilerTimer) {
      // Note: We don't reset the actualTime counts. It's useful to accumulate
      // actual time across multiple render passes.
      workInProgress.selfBaseDuration = 0;
      workInProgress.treeBaseDuration = 0;
    }
  } else {
    // Reset to the cloned values that createWorkInProgress would've.
    workInProgress.childExpirationTime = current.childExpirationTime;
    workInProgress.expirationTime = current.expirationTime;

    workInProgress.child = current.child;
    workInProgress.memoizedProps = current.memoizedProps;
    workInProgress.memoizedState = current.memoizedState;
    workInProgress.updateQueue = current.updateQueue;

    // Clone the dependencies object. This is mutated during the render phase, so
    // it cannot be shared with the current fiber.
    const currentDependencies = current.dependencies;
    workInProgress.dependencies =
      currentDependencies === null
        ? null
        : {
            expirationTime: currentDependencies.expirationTime,
            firstContext: currentDependencies.firstContext,
            responders: currentDependencies.responders,
          };

    if (enableProfilerTimer) {
      // Note: We don't reset the actualTime counts. It's useful to accumulate
      // actual time across multiple render passes.
      workInProgress.selfBaseDuration = current.selfBaseDuration;
      workInProgress.treeBaseDuration = current.treeBaseDuration;
    }
  }

  return workInProgress;
}

export function createHostRootFiber(tag: RootTag): Fiber {
  let mode;
  if (tag === ConcurrentRoot) {
    mode = ConcurrentMode | BlockingMode | StrictMode;
  } else if (tag === BlockingRoot) {
    mode = BlockingMode | StrictMode;
  } else {
    mode = NoMode;
  }

  if (enableProfilerTimer && isDevToolsPresent) {
    // Always collect profile timings when DevTools are present.
    // This enables DevTools to start capturing timing at any point–
    // Without some nodes in the tree having empty base times.
    // 存在DevTools时，请始终收集配置文件计时。
    // 这使得DevTools可以在树中的某些节点没有空的基时间的情况下开始捕捉时间。
    mode |= ProfileMode;
  }

  return createFiber(HostRoot, null, null, mode);
}

//taichiyi 当一个 React 元素首次被转化为 Fiber 节点的时候，React 使用 element 数据作为参数，来调用函数 createFiberFromTypeAndProps。
export function createFiberFromTypeAndProps(
  type: any, // React$ElementType
  key: null | string,
  pendingProps: any,
  owner: null | Fiber,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
): Fiber {
  let fiber;

  let fiberTag = IndeterminateComponent;
  // The resolved type is set if we know what the final type will be.
  // I.e. it's not lazy.
  // 如果我们知道最终的类型，则将设置解析类型。
  // 即，这不是惰性的。
  let resolvedType = type;
  if (typeof type === 'function') {
    if (shouldConstruct(type)) {
      /* ✨ */fiberTag = ClassComponent;
      if (__DEV__) {
        resolvedType = resolveClassForHotReloading(resolvedType);
      }
    } else {
      if (__DEV__) {
        resolvedType = resolveFunctionForHotReloading(resolvedType);
      }
    }
  } else if (typeof type === 'string') {
    fiberTag = HostComponent;
  } else {
    getTag: switch (type) {
      case REACT_FRAGMENT_TYPE:
        return createFiberFromFragment(
          pendingProps.children,
          mode,
          expirationTime,
          key,
        );
      case REACT_CONCURRENT_MODE_TYPE:
        fiberTag = Mode;
        mode |= ConcurrentMode | BlockingMode | StrictMode;
        break;
      case REACT_STRICT_MODE_TYPE:
        fiberTag = Mode;
        mode |= StrictMode;
        break;
      case REACT_PROFILER_TYPE:
        return createFiberFromProfiler(pendingProps, mode, expirationTime, key);
      case REACT_SUSPENSE_TYPE:
        return createFiberFromSuspense(pendingProps, mode, expirationTime, key);
      case REACT_SUSPENSE_LIST_TYPE:
        return createFiberFromSuspenseList(
          pendingProps,
          mode,
          expirationTime,
          key,
        );
      default: {
        if (typeof type === 'object' && type !== null) {
          switch (type.$$typeof) {
            case REACT_PROVIDER_TYPE:
              fiberTag = ContextProvider;
              break getTag;
            case REACT_CONTEXT_TYPE:
              // This is a consumer
              fiberTag = ContextConsumer;
              break getTag;
            case REACT_FORWARD_REF_TYPE:
              fiberTag = ForwardRef;
              if (__DEV__) {
                resolvedType = resolveForwardRefForHotReloading(resolvedType);
              }
              break getTag;
            case REACT_MEMO_TYPE:
              /* ✨ */fiberTag = MemoComponent;
              break getTag;
            case REACT_LAZY_TYPE:
              fiberTag = LazyComponent;
              resolvedType = null;
              break getTag;
            case REACT_FUNDAMENTAL_TYPE:
              if (enableFundamentalAPI) {
                return createFiberFromFundamental(
                  type,
                  pendingProps,
                  mode,
                  expirationTime,
                  key,
                );
              }
              break;
            case REACT_SCOPE_TYPE:
              if (enableScopeAPI) {
                return createFiberFromScope(
                  type,
                  pendingProps,
                  mode,
                  expirationTime,
                  key,
                );
              }
          }
        }
        let info = '';
        if (__DEV__) {
          if (
            type === undefined ||
            (typeof type === 'object' &&
              type !== null &&
              Object.keys(type).length === 0)
          ) {
            info +=
              ' You likely forgot to export your component from the file ' +
              "it's defined in, or you might have mixed up default and " +
              'named imports.';
          }
          const ownerName = owner ? getComponentName(owner.type) : null;
          if (ownerName) {
            info += '\n\nCheck the render method of `' + ownerName + '`.';
          }
        }
        invariant(
          false,
          'Element type is invalid: expected a string (for built-in ' +
            'components) or a class/function (for composite components) ' +
            'but got: %s.%s',
          type == null ? type : typeof type,
          info,
        );
      }
    }
  }

  fiber = createFiber(fiberTag, pendingProps, key, mode);
  fiber.elementType = type;
  fiber.type = resolvedType;
  fiber.expirationTime = expirationTime;

  return fiber;
}

export function createFiberFromElement(
  element: ReactElement,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
): Fiber {
  let owner = null;
  if (__DEV__) {
    owner = element._owner;
  }
  const type = element.type;
  const key = element.key;
  const pendingProps = element.props;
  const fiber = createFiberFromTypeAndProps(
    type,
    key,
    pendingProps,
    owner,
    mode,
    expirationTime,
  );
  if (__DEV__) {
    fiber._debugSource = element._source;
    fiber._debugOwner = element._owner;
  }
  return fiber;
}

export function createFiberFromFragment(
  elements: ReactFragment,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
  key: null | string,
): Fiber {
  const fiber = createFiber(Fragment, elements, key, mode);
  fiber.expirationTime = expirationTime;
  return fiber;
}

export function createFiberFromFundamental(
  fundamentalComponent: ReactFundamentalComponent<any, any>,
  pendingProps: any,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
  key: null | string,
): Fiber {
  const fiber = createFiber(FundamentalComponent, pendingProps, key, mode);
  fiber.elementType = fundamentalComponent;
  fiber.type = fundamentalComponent;
  fiber.expirationTime = expirationTime;
  return fiber;
}

function createFiberFromScope(
  scope: ReactScope,
  pendingProps: any,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
  key: null | string,
) {
  const fiber = createFiber(ScopeComponent, pendingProps, key, mode);
  fiber.type = scope;
  fiber.elementType = scope;
  fiber.expirationTime = expirationTime;
  return fiber;
}

function createFiberFromProfiler(
  pendingProps: any,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
  key: null | string,
): Fiber {
  if (__DEV__) {
    if (
      typeof pendingProps.id !== 'string' ||
      typeof pendingProps.onRender !== 'function'
    ) {
      warningWithoutStack(
        false,
        'Profiler must specify an "id" string and "onRender" function as props',
      );
    }
  }

  const fiber = createFiber(Profiler, pendingProps, key, mode | ProfileMode);
  // TODO: The Profiler fiber shouldn't have a type. It has a tag.
  fiber.elementType = REACT_PROFILER_TYPE;
  fiber.type = REACT_PROFILER_TYPE;
  fiber.expirationTime = expirationTime;

  return fiber;
}

export function createFiberFromSuspense(
  pendingProps: any,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
  key: null | string,
) {
  const fiber = createFiber(SuspenseComponent, pendingProps, key, mode);

  // TODO: The SuspenseComponent fiber shouldn't have a type. It has a tag.
  // This needs to be fixed in getComponentName so that it relies on the tag
  // instead.
  fiber.type = REACT_SUSPENSE_TYPE;
  fiber.elementType = REACT_SUSPENSE_TYPE;

  fiber.expirationTime = expirationTime;
  return fiber;
}

export function createFiberFromSuspenseList(
  pendingProps: any,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
  key: null | string,
) {
  const fiber = createFiber(SuspenseListComponent, pendingProps, key, mode);
  if (__DEV__) {
    // TODO: The SuspenseListComponent fiber shouldn't have a type. It has a tag.
    // This needs to be fixed in getComponentName so that it relies on the tag
    // instead.
    fiber.type = REACT_SUSPENSE_LIST_TYPE;
  }
  fiber.elementType = REACT_SUSPENSE_LIST_TYPE;
  fiber.expirationTime = expirationTime;
  return fiber;
}

export function createFiberFromText(
  content: string,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
): Fiber {
  const fiber = createFiber(HostText, content, null, mode);
  fiber.expirationTime = expirationTime;
  return fiber;
}

export function createFiberFromHostInstanceForDeletion(): Fiber {
  const fiber = createFiber(HostComponent, null, null, NoMode);
  // TODO: These should not need a type.
  fiber.elementType = 'DELETED';
  fiber.type = 'DELETED';
  return fiber;
}

export function createFiberFromDehydratedFragment(
  dehydratedNode: SuspenseInstance,
): Fiber {
  const fiber = createFiber(DehydratedFragment, null, null, NoMode);
  fiber.stateNode = dehydratedNode;
  return fiber;
}

export function createFiberFromPortal(
  portal: ReactPortal,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
): Fiber {
  const pendingProps = portal.children !== null ? portal.children : [];
  const fiber = createFiber(HostPortal, pendingProps, portal.key, mode);
  fiber.expirationTime = expirationTime;
  fiber.stateNode = {
    containerInfo: portal.containerInfo,
    pendingChildren: null, // Used by persistent updates
    implementation: portal.implementation,
  };
  return fiber;
}

// Used for stashing WIP properties to replay failed work in DEV.
export function assignFiberPropertiesInDEV(
  target: Fiber | null,
  source: Fiber,
): Fiber {
  if (target === null) {
    // This Fiber's initial properties will always be overwritten.
    // We only use a Fiber to ensure the same hidden class so DEV isn't slow.
    target = createFiber(IndeterminateComponent, null, null, NoMode);
  }

  // This is intentionally written as a list of all properties.
  // We tried to use Object.assign() instead but this is called in
  // the hottest path, and Object.assign() was too slow:
  // https://github.com/facebook/react/issues/12502
  // This code is DEV-only so size is not a concern.

  target.tag = source.tag;
  target.key = source.key;
  target.elementType = source.elementType;
  target.type = source.type;
  target.stateNode = source.stateNode;
  target.return = source.return;
  target.child = source.child;
  target.sibling = source.sibling;
  target.index = source.index;
  target.ref = source.ref;
  target.pendingProps = source.pendingProps;
  target.memoizedProps = source.memoizedProps;
  target.updateQueue = source.updateQueue;
  target.memoizedState = source.memoizedState;
  target.dependencies = source.dependencies;
  target.mode = source.mode;
  target.effectTag = source.effectTag;
  target.nextEffect = source.nextEffect;
  target.firstEffect = source.firstEffect;
  target.lastEffect = source.lastEffect;
  target.expirationTime = source.expirationTime;
  target.childExpirationTime = source.childExpirationTime;
  target.alternate = source.alternate;
  if (enableProfilerTimer) {
    target.actualDuration = source.actualDuration;
    target.actualStartTime = source.actualStartTime;
    target.selfBaseDuration = source.selfBaseDuration;
    target.treeBaseDuration = source.treeBaseDuration;
  }
  target._debugID = source._debugID;
  target._debugSource = source._debugSource;
  target._debugOwner = source._debugOwner;
  target._debugIsCurrentlyTiming = source._debugIsCurrentlyTiming;
  target._debugNeedsRemount = source._debugNeedsRemount;
  target._debugHookTypes = source._debugHookTypes;
  return target;
}
