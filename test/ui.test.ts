/**
 * UI 状态机穷举测试：所有状态 × 所有事件，逐条检查不变式。
 * 这是"代替用户点按钮"的替代品——它证明不了好看，但能证明不会卡死。
 */
import {
  reduce,
  checkInvariants,
  initialState,
  defaultSize,
  ASPECT,
  type UiState,
  type UiEvent,
  type Phase,
} from '../src/client/uiState.js';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const ALL_PHASES: Phase[] = ['idle', 'running', 'paused', 'conflict', 'stopped'];

const EVENTS: UiEvent[] = [
  { type: 'phase', phase: 'idle' },
  { type: 'phase', phase: 'running' },
  { type: 'phase', phase: 'paused' },
  { type: 'phase', phase: 'conflict' },
  { type: 'phase', phase: 'stopped' },
  { type: 'minimize' },
  { type: 'expand' },
  { type: 'show' },
  { type: 'toggleFullscreen' },
  { type: 'requestClose' },
  { type: 'confirmHide' },
  { type: 'confirmExit' },
  { type: 'cancelClose' },
  { type: 'toggleInput' },
  { type: 'agentActed' },
  { type: 'moveTo', pos: { x: 100, y: 100 } },
  { type: 'moveBall', pos: { x: 20, y: 20 } },
  { type: 'resize', size: { w: 640, h: 640 / ASPECT } },
  { type: 'resetPlacement' },
];

// 1. 单步穷举
{
  let violations = 0;
  let cases = 0;
  for (const phase of ALL_PHASES) {
    for (const event of EVENTS) {
      let s: UiState = reduce(initialState, { type: 'phase', phase });
      const next = reduce(s, event);
      const bad = checkInvariants(next);
      cases++;
      if (bad.length) {
        violations++;
        if (violations <= 8) console.log(`  VIOLATION ${phase} + ${event.type} → ${bad.join('; ')}`);
      }
    }
  }
  check('单步穷举无违例', violations === 0, `${cases} 个用例`);
}

// 2. 两步穷举
{
  let violations = 0;
  let cases = 0;
  for (const phase of ALL_PHASES) {
    for (const e1 of EVENTS) {
      for (const e2 of EVENTS) {
        let s: UiState = reduce(initialState, { type: 'phase', phase });
        s = reduce(s, e1);
        s = reduce(s, e2);
        const bad = checkInvariants(s);
        cases++;
        if (bad.length) {
          violations++;
          if (violations <= 6) {
            console.log(`  VIOLATION ${phase}: ${e1.type} → ${e2.type} → ${bad.join('; ')}`);
          }
        }
      }
    }
  }
  check('两步穷举无违例', violations === 0, `${cases} 个用例`);
}

// 3. 三步穷举（覆盖跨异步的退出/隐藏路径）
{
  let violations = 0;
  let cases = 0;
  const FOCUS: UiEvent[] = [
    { type: 'requestClose' },
    { type: 'confirmExit' },
    { type: 'confirmHide' },
    { type: 'minimize' },
    { type: 'expand' },
    { type: 'show' },
    { type: 'agentActed' },
    { type: 'phase', phase: 'stopped' },
    { type: 'phase', phase: 'running' },
    { type: 'phase', phase: 'idle' },
  ];
  for (const phase of ALL_PHASES) {
    for (const e1 of FOCUS) {
      for (const e2 of FOCUS) {
        for (const e3 of FOCUS) {
          let s: UiState = reduce(initialState, { type: 'phase', phase });
          s = reduce(s, e1);
          s = reduce(s, e2);
          s = reduce(s, e3);
          const bad = checkInvariants(s);
          cases++;
          if (bad.length) {
            violations++;
            if (violations <= 6) {
              console.log(
                `  VIOLATION ${phase}: ${e1.type} → ${e2.type} → ${e3.type} → ${bad.join('; ')}`,
              );
            }
          }
        }
      }
    }
  }
  check('三步穷举无违例', violations === 0, `${cases} 个用例`);
}

// 4. 仅隐藏：整个界面消失，不是缩成球
{
  let s = reduce(initialState, { type: 'phase', phase: 'running' });
  s = reduce(s, { type: 'requestClose' });
  s = reduce(s, { type: 'confirmHide' });
  check('仅隐藏后 view=hidden（不是 ball）', s.view === 'hidden', s.view);
  check('仅隐藏后 userHidden=true', s.userHidden === true);
  s = reduce(s, { type: 'phase', phase: 'running' });
  check('仅隐藏后 phase 事件不会把界面拉回来', s.view === 'hidden', s.view);
  s = reduce(s, { type: 'agentActed' });
  check('仅隐藏后 agent 动作也不打扰用户', s.view === 'hidden', s.view);
  s = reduce(s, { type: 'show' });
  check('vdesk_show 能唤回面板', s.view === 'panel', s.view);
  check('唤回后 userHidden 清除', s.userHidden === false);
}

// 5. 退出运行：立即消失，且 phase 事件不得拉回
{
  let s = reduce(initialState, { type: 'phase', phase: 'running' });
  s = reduce(s, { type: 'toggleFullscreen' });
  s = reduce(s, { type: 'requestClose' });
  s = reduce(s, { type: 'confirmExit' });
  check('全屏下终止：立即隐藏', s.view === 'hidden', s.view);
  s = reduce(s, { type: 'phase', phase: 'running' });
  check('全屏下终止：phase 事件不会拉回面板', s.view === 'hidden', s.view);
  s = reduce(s, { type: 'phase', phase: 'stopped' });
  check('全屏下终止：仍保持隐藏', s.view === 'hidden', s.view);
  const s2 = reduce(s, { type: 'phase', phase: 'running' });
  check('再开新任务自动回到面板', s2.view === 'panel', s2.view);
}

// 6. 终止未生效时的恢复路径
{
  let f = reduce(initialState, { type: 'phase', phase: 'running' });
  f = reduce(f, { type: 'confirmExit' });
  f = reduce(f, { type: 'agentActed' });
  check('终止未生效时 agent 动作能恢复面板', f.view === 'panel', f.view);
}

// 7. 收成球 / 点球展开
{
  let s = reduce(initialState, { type: 'phase', phase: 'running' });
  s = reduce(s, { type: 'minimize' });
  check('最小化后是球', s.view === 'ball', s.view);
  s = reduce(s, { type: 'expand' });
  check('点球回到面板', s.view === 'panel', s.view);
}

// 8. 任务结束时全部归零
{
  let s = reduce(initialState, { type: 'phase', phase: 'running' });
  s = reduce(s, { type: 'resize', size: { w: 640, h: 640 / ASPECT } });
  s = reduce(s, { type: 'moveBall', pos: { x: 500, y: 500 } });
  s = reduce(s, { type: 'phase', phase: 'idle' });
  check('任务结束回到 hidden', s.view === 'hidden', s.view);
  check('任务结束尺寸复位', s.size.w === defaultSize().w && s.size.h === defaultSize().h);
  check('任务结束球位置复位', s.ballPos === null);
}

// 9. 几何：任意合法尺寸都保持 16:10
{
  let ok = true;
  for (const w of [320, 400, 512, 640, 800]) {
    let s = reduce(initialState, { type: 'phase', phase: 'running' });
    s = reduce(s, { type: 'resize', size: { w, h: w / ASPECT } });
    const bad = checkInvariants(s);
    if (bad.length) {
      ok = false;
      console.log(`  BAD w=${w}: ${bad.join('; ')}`);
    }
  }
  check('缩放保持 16:10 比例', ok);
}

// 10. 空闲时任何交互都不该凭空造出 UI
{
  let ok = true;
  for (const e of EVENTS) {
    const s = reduce(initialState, e);
    if (s.view !== 'hidden' && s.phase === 'idle') {
      ok = false;
      console.log(`  BAD idle + ${e.type} → view=${s.view}`);
    }
  }
  check('空闲时不会凭空出现 UI', ok);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
