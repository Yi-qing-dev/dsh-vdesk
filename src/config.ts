export interface VDesktopConfig {
  /** 旧 sidecar（Python 子进程）保留字段，VBox provider 下不再使用。 */
  sidecarPath: string;
  sidecarArgs: string[];
  sidecarCwd: string;
  callTimeoutMs: number;
  framePort: number;
  framePortMax: number;
  webOrigin: string;
  frameDir: string;
  /** VBox provider：VBoxManage.exe 绝对路径。 */
  vboxManage: string;
  /** VBox provider：客户机 VM 名称。 */
  vmName: string;
  /** VBox provider：客户机本地账户。 */
  guestUser: string;
  /** VBox provider：客户机本地账户密码。 */
  guestPass: string;
}

export type VdeskConfig = VDesktopConfig;

export const defaultConfig: VDesktopConfig = {
  sidecarPath: 'python',
  sidecarArgs: ['-m', 'dshv', '--rpc', 'stdio'],
  sidecarCwd: '',
  callTimeoutMs: 30_000,
  framePort: 8790,
  framePortMax: 8799,
  webOrigin: 'http://127.0.0.1:3080',
  frameDir: '',
  vboxManage: 'C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe',
  vmName: 'dsh-vdesk',
  guestUser: 'vuser',
  guestPass: '', // 客户机密码由插件配置注入，不入库
};
