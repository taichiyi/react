/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * @param {array} arr an "accumulation" of items which is either an Array or a single item.
 * “ arr”项目的“累加”，可以是数组，也可以是单个项目。
 * Useful when paired with the `accumulate` module.
 * 与 `accumulate` 模块搭配使用时非常有用。
 * This is a simple utility that allows us to reason about a collection of items, but handling the case when there is exactly one item (and we do not need to allocate an array).
 * 这是一个简单的实用程序，使我们可以推理一组项目，但是可以在只有一个项目（并且我们不需要分配数组）的情况下进行处理。
 * @param {function} cb Callback invoked with each element or a collection.
 * @param {?} [scope] Scope used as `this` in a callback.
 */
function forEachAccumulated<T>(
  arr: ?(Array<T> | T),
  cb: (elem: T) => void,
  scope: ?any,
) {
  if (Array.isArray(arr)) {
    arr.forEach(cb, scope);
  } else if (arr) {
    cb.call(scope, arr);
  }
}

export default forEachAccumulated;
