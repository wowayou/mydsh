// mydsh ui-notify — browser-side task completion notification (Notification API + sound).
//
// Two registrations:
// 1. conversation.input.dock#mydsh-notify — null component, detects running→idle, fires notification.
//    Uses useSession + interval poll to work even when the tab is hidden (React defers
//    re-renders in hidden tabs; the poll bypasses that).
// 2. settings.general.item#mydsh-notify-sound — a settings card in Settings → General where
//    users pick a custom notification sound file (.mp3/.wav/.ogg/.m4a), test it, or reset
//    to the default Web Audio beep. Stored in localStorage (base64 data URL).
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
			    label: '完成提醒声音', upload: '选择音频文件', test: '试听', remove: '恢复默认',
			    custom: '自定义音频', default: '默认提示音', none: '未设置' }
			: { title: 'Task done', body: 'The session has finished',
			    label: 'Completion sound', upload: 'Choose audio file', test: 'Test', remove: 'Reset',
			    custom: 'Custom audio', default: 'Default beep', none: 'Not set' };

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

		// --- Settings card: sound configuration ---
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
				display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
			};
			var labelStyle = {
				fontSize: 13, fontWeight: 500,
				color: 'var(--dsw-alias-label-primary, #e6e9ef)', minWidth: 80,
			};
			var btnBase = {
				cursor: 'pointer', fontSize: 12, borderRadius: 6, padding: '4px 10px',
				border: '1px solid var(--dsw-alias-border-l2, #3a4152)',
				background: 'var(--dsw-alias-bg-layer-2, #171a21)',
				color: 'var(--dsw-alias-label-secondary, #9aa3b2)',
			};
			var statusStyle = {
				fontSize: 12, color: hasCustom
					? 'var(--dsw-alias-state-success-primary, #3fae6a)'
					: 'var(--dsw-alias-label-tertiary, #6b7280)',
			};

			return createElement('div', { style: rowStyle },
				createElement('span', { style: labelStyle }, T.label),
				createElement('span', { style: statusStyle }, hasCustom ? T.custom : T.default),
				createElement('label', {
					style: { ...btnBase, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' },
				}, T.upload,
					createElement('input', {
						ref: fileRef, type: 'file',
						accept: 'audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac',
						style: { display: 'none' },
						onChange: onFile,
					}),
				),
				createElement('button', { style: btnBase, onClick: onTest }, T.test),
				hasCustom ? createElement('button', {
					style: { ...btnBase, color: 'var(--dsw-alias-state-warn-primary, #e0a03c)' },
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
				// 1. Detection watcher (null component in input dock).
				ctx.effect(
					() => slots.inject('conversation.input.dock', () => slots.register({
						name: 'conversation.input.dock',
						id: 'mydsh-notify',
						order: 100,
					}, NotifyWatcher)),
					'@mydsh/ui-notify: dock watcher',
				);
				// 2. Sound settings card in Settings → General.
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