// mydsh ui-notify — browser-side task completion notification (Notification API + sound).
//
// Features:
// - Detects running→idle transition via useSession + interval poll (works in hidden tabs).
// - Fires browser Notification + sound on task completion.
// - Custom sound: user can upload an audio file (.mp3/.wav/.ogg/.m4a).
//   Stored in localStorage as base64; falls back to Web Audio beep if unset.
// - A small "bell" button in the input dock lets users pick/change/remove the sound.
//
// Hand-written __ModuleLoader__ bundle (zero build deps): only requires react.
window.__ModuleLoader__.load({
	id: '@mydsh/ui-notify',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require('react');
		const { useEffect, useRef, useState, useCallback, createElement } = React;

		const SOUND_KEY = 'mydsh.notify.sound';

		function isZh() {
			try { return (navigator.language || '').toLowerCase().startsWith('zh'); } catch { return false; }
		}
		const T = isZh()
			? { title: '任务完成', body: '会话已完成', soundBtn: '🔔 提示音', upload: '选择音频文件', remove: '恢复默认提示音', custom: '自定义', default: '默认' }
			: { title: 'Task done', body: 'The session has finished', soundBtn: '🔔 Sound', upload: 'Choose audio file', remove: 'Reset to default beep', custom: 'Custom', default: 'Default' };

		/** Load custom sound from localStorage (base64 data URL or null). */
		function loadCustomSound() {
			try { return localStorage.getItem(SOUND_KEY); } catch { return null; }
		}

		/** Save custom sound to localStorage as base64 data URL. */
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

		/** Remove custom sound from localStorage. */
		function clearCustomSound() {
			try { localStorage.removeItem(SOUND_KEY); } catch {}
		}

		/** Short beep (Web Audio, silent on failure). */
		function beep() {
			try {
				const Ctx = window.AudioContext || window.webkitAudioContext;
				if (!Ctx) return;
				const ac = new Ctx();
				const osc = ac.createOscillator();
				const gain = ac.createGain();
				osc.connect(gain);
				gain.connect(ac.destination);
				osc.type = 'sine';
				osc.frequency.value = 880;
				gain.gain.setValueAtTime(0.1, ac.currentTime);
				gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.4);
				osc.start();
				osc.stop(ac.currentTime + 0.45);
				osc.onended = function() { try { ac.close(); } catch {} };
			} catch {}
		}

		/** Play custom sound from data URL, fall back to beep. */
		function playSound() {
			var custom = loadCustomSound();
			if (custom) {
				try {
					var audio = new Audio(custom);
					audio.volume = 0.8;
					audio.play().catch(function() { beep(); });
					return;
				} catch { beep(); return; }
			}
			beep();
		}

		/** Browser notification + sound. */
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

		/** Small sound picker button in the input dock. */
		function SoundPicker(props) {
			var fileRef = useRef(null);
			var hasCustom = useState(loadCustomSound() !== null);
			var hasCustomVal = hasCustom[0]; var setHasCustom = hasCustom[1];
			var showMenu = useState(false);
			var showMenuVal = showMenu[0]; var setShowMenu = showMenu[1];

			var onFile = useCallback(function(e) {
				var file = e.target.files && e.target.files[0];
				if (!file) return;
				saveCustomSound(file).then(function() {
					setHasCustom(true);
					setShowMenu(false);
					// Preview the sound
					playSound();
				}).catch(function() {
					setShowMenu(false);
				});
				// Reset input so the same file can be re-selected
				if (fileRef.current) fileRef.current.value = '';
			}, []);

			var onRemove = useCallback(function() {
				clearCustomSound();
				setHasCustom(false);
				setShowMenu(false);
			}, []);

			var btnStyle = {
				background: 'transparent', border: 'none', cursor: 'pointer',
				color: 'var(--dsw-alias-label-tertiary, #6b7280)',
				fontSize: '14px', padding: '2px 4px', borderRadius: 4, lineHeight: 1,
			};

			var menuStyle = {
				position: 'absolute', bottom: '100%', left: 0, marginBottom: 4,
				background: 'var(--dsw-alias-bg-overlay, #20242e)',
				border: '1px solid var(--dsw-alias-border-l2, #3a4152)',
				borderRadius: 8, padding: '6px 4px', whiteSpace: 'nowrap',
				boxShadow: '0 4px 16px rgba(0,0,0,.3)', zIndex: 10000,
			};

			var itemStyle = {
				display: 'block', width: '100%', textAlign: 'left',
				background: 'transparent', border: 'none', cursor: 'pointer',
				color: 'var(--dsw-alias-label-primary, #e6e9ef)',
				fontSize: '12px', padding: '4px 10px', borderRadius: 4,
			};

			return createElement('div', { style: { position: 'relative', display: 'inline-block' } },
				createElement('button', {
					title: T.soundBtn,
					onClick: function() { setShowMenu(!showMenuVal); },
					style: btnStyle,
				}, hasCustomVal ? '🔔' : '🔕'),
				showMenuVal ? createElement('div', { style: menuStyle },
					createElement('label', { style: { ...itemStyle, cursor: 'pointer' } },
						T.upload + (hasCustomVal ? ' (' + T.custom + ')' : ''),
						createElement('input', {
							ref: fileRef,
							type: 'file',
							accept: 'audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac',
							style: { display: 'none' },
							onChange: onFile,
						}),
					),
					hasCustomVal ? createElement('button', {
						style: { ...itemStyle, color: 'var(--dsw-alias-state-warn-primary, #e0a03c)' },
						onClick: onRemove,
					}, T.remove) : null,
				) : null,
			);
		}

		/** Session-scope watcher: renders null, fires notification on running→idle. */
		function NotifyWatcher(props) {
			var useSession = props.useSession;
			var sessionId = props.sessionId;
			var runningRef = useRef(undefined);

			// React state-based detection (works when tab is visible).
			var running = useSession(function(s) { return s ? s.running : false; });
			useEffect(function() {
				var was = runningRef.current;
				runningRef.current = running;
				if (was === true && running === false) {
					notify(T.title, T.body + ' · ' + String(sessionId));
				}
			}, [running, sessionId]);

			// Interval-based detection (works even when tab is hidden).
			useEffect(function() {
				var check = function() {
					try {
						var current = useSession(function(s) { return s ? s.running : false; });
						var was = runningRef.current;
						runningRef.current = current;
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

		module.exports = {
			name: '@mydsh/ui-notify',
			inject: ['slots'],
			apply(ctx) {
				var slots = ctx.get('slots');
				if (slots === undefined) return;
				// Notification watcher (null component, no visual).
				ctx.effect(
					() => slots.inject('conversation.input.dock', () => slots.register({
						name: 'conversation.input.dock',
						id: 'mydsh-notify',
						order: 100,
					}, NotifyWatcher)),
					'@mydsh/ui-notify: dock watcher',
				);
				// Sound picker button (small, in the input dock).
				ctx.effect(
					() => slots.inject('conversation.input.dock', () => slots.register({
						name: 'conversation.input.dock',
						id: 'mydsh-sound-picker',
						order: 99,
					}, SoundPicker)),
					'@mydsh/ui-notify: sound picker',
				);
			},
		};
		return module.exports;
	}
});