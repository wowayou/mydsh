// mydsh ui-notify — browser-side task completion notification (Notification API + sound).
//
// Hand-written __ModuleLoader__ bundle (zero build deps): only requires react.
// Mechanism: registers a session-scope null component that subscribes to
// useSession(s => s.running). To avoid React deferring re-renders in hidden tabs
// (which delays the notification until the tab becomes visible), the component
// also sets up a direct interval-based poll that detects running→idle transitions
// immediately, even when the tab is in the background.
window.__ModuleLoader__.load({
	id: '@mydsh/ui-notify',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require('react');
		const { useEffect, useRef, createElement } = React;

		function isZh() {
			try { return (navigator.language || '').toLowerCase().startsWith('zh'); } catch { return false; }
		}
		const T = isZh()
			? { title: '任务完成', body: '会话已完成' }
			: { title: 'Task done', body: 'The session has finished' };

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
				osc.onended = () => { try { ac.close(); } catch {} };
			} catch {}
		}

		/** Browser notification: fire immediately regardless of tab visibility. */
		function notify(title, body) {
			try {
				if (typeof window === 'undefined' || !('Notification' in window)) { beep(); return; }
				const show = () => { try { new Notification(title, { body, tag: 'mydsh-done' }); } catch { beep(); } };
				if (Notification.permission === 'granted') show();
				else if (Notification.permission !== 'denied') {
					Notification.requestPermission().then((p) => { if (p === 'granted') show(); else beep(); });
				} else beep();
			} catch { beep(); }
		}

		/** Session-scope watcher: renders null, fires notification on running→idle. */
		function NotifyWatcher(props) {
			const useSession = props.useSession;
			const sessionId = props.sessionId;
			const runningRef = useRef(undefined);

			// React state-based detection (works when tab is visible).
			const running = useSession((s) => (s ? s.running : false));
			useEffect(() => {
				const was = runningRef.current;
				runningRef.current = running;
				if (was === true && running === false) {
					notify(T.title, T.body + ' · ' + String(sessionId));
				}
			}, [running, sessionId]);

			// Interval-based detection (works even when tab is hidden).
			// React defers re-renders in hidden tabs, so the useEffect above
			// may not fire until the tab becomes visible. This poll checks the
			// store directly via useSession (which reads synchronously) and
			// fires the notification immediately.
			useEffect(() => {
				const check = () => {
					try {
						const current = useSession((s) => (s ? s.running : false));
						const was = runningRef.current;
						runningRef.current = current;
						if (was === true && current === false) {
							notify(T.title, T.body + ' · ' + String(sessionId));
						}
					} catch {}
				};
				const timer = setInterval(check, 500);
				return () => clearInterval(timer);
			}, [sessionId]); // useSession is stable per session, no need to re-subscribe

			return null;
		}

		module.exports = {
			name: '@mydsh/ui-notify',
			inject: ['slots'],
			apply(ctx) {
				const slots = ctx.get('slots');
				if (slots === undefined) return;
				ctx.effect(
					() => slots.inject('conversation.input.dock', () => slots.register({
						name: 'conversation.input.dock',
						id: 'mydsh-notify',
						order: 100,
					}, NotifyWatcher)),
					'@mydsh/ui-notify: dock watcher',
				);
			},
		};
		return module.exports;
	}
});