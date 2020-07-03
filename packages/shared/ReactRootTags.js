/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

export type RootTag = 0 | 1 | 2;

// 对应 “legacy 模式” “blocking 模式” “concurrent 模式”
export const LegacyRoot = 0;
export const BlockingRoot = 1;
export const ConcurrentRoot = 2;

// 为什么有这么多模式？
// https://zh-hans.reactjs.org/docs/concurrent-mode-adoption.html#why-so-many-modes
// React 新增了很多功能，为了保证兼容的情况下实现迁移，所以设置几种模式
