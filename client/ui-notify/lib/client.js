// mydsh ui-notify — 浏览器半边：任务完成提醒（Notification API + 提示音）。
//
// 手写 __ModuleLoader__ bundle（零构建依赖）：只 require 平台模块表里的 react。
// 机制：挂一个会话作用域的 null 组件，订阅 useSession(s => s.running)，
// 在 running -> idle 的下降沿、且页面处于后台（document.hidden）时发通知。
// 用户正看着页面时不打扰；浏览器未开/无权限时由主机层 notify-send 兜底。
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
			? { title: '任务完成', body: '会话已完成', fail: '无法发送浏览器通知' }
			: { title: 'Task done', body: 'The session has finished', fail: 'Browser notification unavailable' };

		/** 短提示音（Web Audio，失败静默）。 */
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

		/** 浏览器通知：有权限直接发，未决定则请求一次，拒绝则只响提示音。 */
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

		/** 会话作用域观察器：渲染 null，只跑副作用。 */
		function NotifyWatcher(props) {
			const useSession = props.useSession;
			const sessionId = props.sessionId;
			const running = useSession((s) => (s ? s.running : false));
			const prev = useRef(undefined);
			useEffect(() => {
				const was = prev.current;
				prev.current = running;
				if (was !== true || running !== false) return;
				let hidden = false;
				try { hidden = document.hidden; } catch {}
				if (!hidden) return;
				notify(T.title, T.body + ' · ' + String(sessionId));
			}, [running, sessionId]);
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
