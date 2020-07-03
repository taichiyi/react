/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

export type TypeOfMode = number;

export const NoMode = 0b0000;
export const StrictMode = 0b0001; // 严格模式
// TODO: Remove BlockingMode and ConcurrentMode by reading from the root tag instead
// TODO: 改为通过读取根标记来删除 BlockingMode 和 ConcurrentMode
export const BlockingMode = 0b0010; // 阻塞模式
export const ConcurrentMode = 0b0100; // 并发模式
export const ProfileMode = 0b1000; // 配置文件模式
