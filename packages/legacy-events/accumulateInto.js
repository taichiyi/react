/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import invariant from 'shared/invariant';

/**
 * Accumulates items that must not be null or undefined into the first one.
 * 将不能为空或未定义的项累积到第一个项中。
 *
 * This is used to conserve memory by avoiding array allocations, and thus sacrifices API cleanness.
 * 这用于通过避免数组分配来节省内存，从而牺牲了API的简洁性。
 *
 * Since `current` can be null before being passed in and not null after this function, make sure to assign it back to `current`:
 * 由于`current`在传入之前可以为null，而在此函数之后不能为null，因此请确保将其分配回`current`：
 *
 * `a = accumulateInto(a, b);`
 *
 * This API should be sparingly used. Try `accumulate` for something cleaner.
 *
 * @return {*|array<*>} An accumulation of items.
 */

function accumulateInto<T>(
  current: ?(Array<T> | T),
  next: T | Array<T>,
): T | Array<T> {
  invariant(
    next != null,
    'accumulateInto(...): Accumulated items must not be null or undefined.',
  );

  if (current == null) {
    return next;
  }

  // Both are not empty. Warning: Never call x.concat(y) when you are not
  // certain that x is an Array (x could be a string with concat method).
  if (Array.isArray(current)) {
    if (Array.isArray(next)) {
      current.push.apply(current, next);
      return current;
    }
    current.push(next);
    return current;
  }

  if (Array.isArray(next)) {
    // A bit too dangerous to mutate `next`.
    return [current].concat(next);
  }

  return [current, next];
}

export default accumulateInto;
