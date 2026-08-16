// mydsh ui-notify — browser-side task completion notification (Notification API + sound).
//
// Two registrations:
// 1. conversation.input.dock#mydsh-notify — null component, detects running→idle.
// (Settings panel registration removed: settings.general.item requires store/locale/inject
//  props that our hand-written bundle doesn't provide, causing render crashes.)
//
// Hand-written __ModuleLoader__ bundle (zero build deps): only requires react.
window.__ModuleLoader__.load({
	id: '@mydsh/ui-notify',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require('react');
		const { useEffect, useRef, useState, useCallback, createElement } = React;

		var SOUND_KEY = 'mydsh.notify.sound';

		function isZh() {
			try { return (navigator.language || '').toLowerCase().startsWith('zh'); } catch { return false; }
		}
		var T = isZh()
			? { title: '任务完成', body: '会话已完成',
			    soundLabel: '完成提示音', test: '试听',
			    custom: '自定义音频', default: '默认提示音',
			    upload: '选择文件', remove: '恢复默认' }
			: { title: 'Task done', body: 'The session has finished',
			    soundLabel: 'Notification sound', test: 'Test',
			    custom: 'Custom audio', default: 'Default beep',
			    upload: 'Choose file', remove: 'Reset' };

		function loadCustomSound() {
			try { return localStorage.getItem(SOUND_KEY); } catch { return null; }
		}
		function saveCustomSound(file) {
			return new Promise(function(resolve, reject) {
				var reader = new FileReader();
				reader.onload = function() {
					try { localStorage.setItem(SOUND_KEY, reader.result); resolve(); } catch(e) { reject(e); }
				};
				reader.onerror = function() { reject(reader.error); };
				reader.readAsDataURL(file);
			});
		}
		function clearCustomSound() {
			try { localStorage.removeItem(SOUND_KEY); } catch {}
		}

		function beep() {
			try {
				var Ctx = window.AudioContext || window.webkitAudioContext;
				if (!Ctx) return;
				var ac = new Ctx();
				var osc = ac.createOscillator();
				var gain = ac.createGain();
				osc.connect(gain); gain.connect(ac.destination);
				osc.type = 'sine'; osc.frequency.value = 880;
				gain.gain.setValueAtTime(0.1, ac.currentTime);
				gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.4);
				osc.start(); osc.stop(ac.currentTime + 0.45);
				osc.onended = function() { try { ac.close(); } catch {} };
			} catch {}
		}

		function playSound() {
			var custom = loadCustomSound();
			if (custom) {
				try { var audio = new Audio(custom); audio.volume = 0.8; audio.play().catch(function() { beep(); }); return; }
				catch {}
			}
			beep();
		}

		function notify(title, body) {
			playSound();
			try {
				if (typeof window === 'undefined' || !('Notification' in window)) return;
				var show = function() { try { new Notification(title, { body, tag: 'mydsh-done' }); } catch {} };
				if (Notification.permission === 'granted') show();
				else if (Notification.permission !== 'denied') {
					Notification.requestPermission().then(function(p) { if (p === 'granted') show(); });
				}
			} catch {}
		}

		// --- Detection component (null, no visual) ---
		function NotifyWatcher(props) {
			var useSession = props.useSession;
			var sessionId = props.sessionId;
			var runningRef = useRef(undefined);

			var running = useSession(function(s) { return s ? s.running : false; });
			useEffect(function() {
				var was = runningRef.current; runningRef.current = running;
				if (was === true && running === false) {
					notify(T.title, T.body + ' · ' + String(sessionId));
				}
			}, [running, sessionId]);

			useEffect(function() {
				var check = function() {
					try {
						var current = useSession(function(s) { return s ? s.running : false; });
						var was = runningRef.current; runningRef.current = current;
						if (was === true && current === false) {
							notify(T.title, T.body + ' · ' + String(sessionId));
						}
					} catch {}
				};
				var timer = setInterval(check, 500);
				return function() { clearInterval(timer); };
			}, [sessionId]);

			return null;
		}

		// --- Settings row: matches DSH General section row pattern ---
		// Visual language from LanguageRow.tsx / AppearanceRow.tsx:
		//   .row: flex, align-center, gap 8px, padding 16px 0, border-bottom hairline
		//   .title: 14px, weight 400, line-height 22px, color label-primary
		//   .selector: h36, r18, bg-module-platform, pad 0/14, font inherit
		function SoundSettings() {
			var fileRef = useRef(null);
			var state = useState(loadCustomSound());
			var customUrl = state[0]; var setCustomUrl = state[1];
			var hasCustom = customUrl !== null;

			var onFile = useCallback(function(e) {
				var file = e.target.files && e.target.files[0];
				if (!file) return;
				saveCustomSound(file).then(function() {
					setCustomUrl(loadCustomSound());
					playSound();
				}).catch(function() {});
				if (fileRef.current) fileRef.current.value = '';
			}, []);

			var onRemove = useCallback(function() {
				clearCustomSound();
				setCustomUrl(null);
			}, []);

			var onTest = useCallback(function() { playSound(); }, []);

			var rowStyle = {
				display: 'flex', alignItems: 'center', gap: '8px', padding: '16px 0',
				borderBottom: '1px solid var(--dsw-alias-border-l2, #3a4152)',
			};
			var textSectionStyle = {
				flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '4px',
			};
			var titleStyle = {
				fontSize: '14px', fontWeight: 400, lineHeight: '22px',
				color: 'var(--dsw-alias-label-primary, #e6e9ef)',
			};
			var subtitleStyle = {
				fontSize: '12px', lineHeight: '18px',
				color: hasCustom ? 'var(--dsw-alias-state-success-primary, #3fae6a)' : 'var(--dsw-alias-label-tertiary, #6b7280)',
			};
			// Selector pill (matches LanguageRow .selector: h36, r18, bg-module-platform)
			var pillStyle = {
				display: 'inline-flex', alignItems: 'center', gap: '6px',
				height: '36px', padding: '0 14px', border: 'none', borderRadius: '18px',
				background: 'var(--dsw-alias-bg-module-platform, #f5f6f7)',
				font: 'inherit', fontSize: '14px', lineHeight: '22px',
				color: 'var(--dsw-alias-label-primary, #e6e9ef)', cursor: 'pointer',
				flexShrink: 0,
			};
			var ghostBtnStyle = {
				display: 'inline-flex', alignItems: 'center',
				height: '36px', padding: '0 12px', border: 'none', borderRadius: '18px',
				background: 'transparent', font: 'inherit', fontSize: '13px',
				color: 'var(--dsw-alias-label-tertiary, #6b7280)', cursor: 'pointer',
				flexShrink: 0,
			};

			return createElement('div', { style: rowStyle },
				createElement('div', { style: textSectionStyle },
					createElement('div', { style: titleStyle }, T.soundLabel),
					createElement('div', { style: subtitleStyle }, hasCustom ? T.custom : T.default),
				),
				// Upload button (styled as selector pill)
				createElement('label', {
					style: Object.assign({}, pillStyle, { cursor: 'pointer' }),
				}, T.upload,
					createElement('input', {
						ref: fileRef, type: 'file',
						accept: 'audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac',
						style: { display: 'none' },
						onChange: onFile,
					}),
				),
				// Test button (ghost style)
				createElement('button', {
					style: ghostBtnStyle, onClick: onTest,
				}, T.test),
				// Reset button (only when custom is set)
				hasCustom ? createElement('button', {
					style: Object.assign({}, ghostBtnStyle, { color: 'var(--dsw-alias-state-warn-primary, #e0a03c)' }),
					onClick: onRemove,
				}, T.remove) : null,
			);
		}

		module.exports = {
			name: '@mydsh/ui-notify',
			inject: ['slots'],
			apply(ctx) {
				var slots = ctx.get('slots');
				if (slots === undefined) return;
				ctx.effect(
					() => slots.inject('conversation.input.dock', () => slots.register({
						name: 'conversation.input.dock',
						id: 'mydsh-notify',
						order: 100,
					}, NotifyWatcher)),
					'@mydsh/ui-notify: dock watcher',
				);
				ctx.effect(
					() => slots.inject('settings.general.item', () => slots.register({
						name: 'settings.general.item',
						id: 'mydsh-notify-sound',
						order: 20,
					}, SoundSettings)),
					'@mydsh/ui-notify: sound settings',
				);
			},
		};
		return module.exports;
	}
});