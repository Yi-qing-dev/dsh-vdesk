/** 冒烟测试入口：把宿主侧类从 bundle 里暴露出来供 node 脚本直接引用。 */
export { FrameServer } from '../src/frameServer.js';
export { VdeskControl } from '../src/control.js';
export { VboxProvider } from '../src/vbox/provider.js';
export { defaultConfig, type VDesktopConfig } from '../src/config.js';
