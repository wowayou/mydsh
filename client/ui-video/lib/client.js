window.__ModuleLoader__.load({
	id: '@mydsh/ui-video',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require('react');
		const { useEffect, createElement } = React;

		const MEDIA_RE = /\.(mp4|webm|mov|m4v|mkv|ogv|mp3|wav|ogg|flac|m4a)(\?.*)?$/i;
		const AUDIO_RE = /\.(mp3|wav|ogg|flac|m4a)(\?.*)?$/i;
		const PROCESSED = 'data-mydsh-media';

		function isExternal(href) {
			try { return /^https?:/i.test(href) || /^data:/i.test(href) || /^javascript:/i.test(href); } catch { return true; }
		}

		/** 一个本地路径 href → /mydsh-media/<b64> 的播放器元素。 */
		function playerFor(href, isAudio) {
			const src = '/mydsh-media/' + encodeURIComponent(href);
			const el = document.createElement(isAudio ? 'audio' : 'video');
			el.controls = true;
			el.preload = 'metadata';
			el.style.maxWidth = '100%';
			el.style.borderRadius = '8px';
			el.style.margin = '6px 0';
			if (!isAudio) el.style.width = 'min(560px, 100%)';
			el.src = src;
			return el;
		}

		/** 扫描并升级一个容器内的媒体链接。 */
		function upgrade(root) {
			const links = root.querySelectorAll ? root.querySelectorAll('a[href]') : [];
			for (const a of links) {
				if (a.getAttribute(PROCESSED) === '1') continue;
				const href = a.getAttribute('href') || '';
				if (!MEDIA_RE.test(href) || isExternal(href)) continue;
				const isAudio = AUDIO_RE.test(href);
				const player = playerFor(href, isAudio);
				a.setAttribute(PROCESSED, '1');
				a.parentNode.replaceChild(player, a);
			}
		}

		/** null 组件：useEffect 管理 MutationObserver 生命周期，卸载时自动断开。 */
		function VideoWatcher() {
			useEffect(() => {
				const boot = () => {
					upgrade(document.body);
					const observer = new MutationObserver(() => { upgrade(document.body); });
					observer.observe(document.body, { childList: true, subtree: true });
					return observer;
				};
				let observer = null;
				if (document.body) observer = boot();
				else {
					const handler = () => { observer = boot(); };
					document.addEventListener('DOMContentLoaded', handler, { once: true });
					return () => { document.removeEventListener('DOMContentLoaded', handler); if (observer) observer.disconnect(); };
				}
				return () => { if (observer) observer.disconnect(); };
			}, []);
			return null;
		}

		module.exports = {
			name: '@mydsh/ui-video',
			inject: ['slots'],
			apply(ctx) {
				const slots = ctx.get('slots');
				if (slots === undefined) return;
				ctx.effect(
					() => slots.inject('conversation.input.dock', () => slots.register({
						name: 'conversation.input.dock',
						id: 'mydsh-video-watcher',
						order: 200,
					}, VideoWatcher)),
					'@mydsh/ui-video: observer',
				);
			},
		};
		return module.exports;
	}
});