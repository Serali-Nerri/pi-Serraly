import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dockShortcutFooterHint,
  parseBackgroundTasksConfig,
  PI_BG_DEFAULT_DOCK_SHORTCUT,
  PI_BG_DOCK_SHORTCUT_VALUES,
} from '../../src/core/config.js';

void describe('background task dock configuration', () => {
  void it('retains only the frozen dock setting and defaults to Shift+Down', () => {
    const config = parseBackgroundTasksConfig({});
    assert.equal(PI_BG_DEFAULT_DOCK_SHORTCUT, 'shift+down');
    assert.deepEqual(config, { dockShortcut: 'shift+down' });
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(PI_BG_DOCK_SHORTCUT_VALUES));
    assert.equal(dockShortcutFooterHint(config.dockShortcut), 'Shift↓');
  });

  void it('ignores residual removed-feature environment values, including malformed ones', () => {
    for (const value of ['', 'delegate', 'process,unknown', 'process, fusion', 'x'.repeat(10_000)]) {
      assert.deepEqual(
        parseBackgroundTasksConfig({
          PI_BG_FEATURES: value,
          PI_BG_DISABLE_PI_TELEMETRY: '1',
          PI_BG_DISABLE_UPDATE_CHECK: '1',
        }),
        { dockShortcut: 'shift+down' },
      );
    }
  });

  void it('accepts only the three finite dock choices and derives their hints', () => {
    assert.deepEqual(PI_BG_DOCK_SHORTCUT_VALUES, ['shift+down', 'ctrl+alt+b', 'off']);
    assert.deepEqual(
      PI_BG_DOCK_SHORTCUT_VALUES.map((shortcut) => [
        parseBackgroundTasksConfig({ PI_BG_DOCK_SHORTCUT: shortcut }).dockShortcut,
        dockShortcutFooterHint(shortcut),
      ]),
      [
        ['shift+down', 'Shift↓'],
        ['ctrl+alt+b', 'CtrlAltB'],
        ['off', '/tasks'],
      ],
    );
  });

  void it('rejects malformed dock settings without fallback or unbounded echo', () => {
    for (const value of ['', 'shift+up', 'Shift+Down', ' shift+down', 'shift+down ', 'off,ctrl+alt+b']) {
      assert.throws(
        () => parseBackgroundTasksConfig({ PI_BG_DOCK_SHORTCUT: value }),
        /pi_bg_config_invalid: PI_BG_DOCK_SHORTCUT.*shift\+down,ctrl\+alt\+b,off/,
        value,
      );
    }
    assert.throws(
      () => parseBackgroundTasksConfig({ PI_BG_DOCK_SHORTCUT: 'x'.repeat(10_000) }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.length < 700);
        assert.doesNotMatch(error.message, /x{200}/);
        return true;
      },
    );
  });
});
