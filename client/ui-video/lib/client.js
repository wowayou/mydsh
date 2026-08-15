// mydsh ui-video — 浏览器半边：把消息里引用的本地视频/音频渲染成播放器。
//
// 手写 __ModuleLoader__ bundle（零构建依赖，纯 DOM，不需要 react）。
// 机制：MutationObserver 扫描消息区，发现指向本地媒体文件的 <a> 链接就替换成 <video>/<audio>。
window.__ModuleLoader__.load({
	id: '@mydsh/ui-video',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const MEDIA_RE = /\.(mp4|webm|mov|m4v|mkv|ogv|mp3|wav|ogg|flac|m4a)(\?.*)?$/i;
		const AUDIO_RE = /\.(mp3|wav|ogg|flac|m4a)(\?.*)?$/i;
		const PROCESSED = 'data-mydsh-media';
		let started = false;

		function isExternal(href) {
			try { return /^https?:/i.test(href) || /^data:/i.test(href) || /^javascript:/i.test(href); } catch { return true; }
		}

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

		function start() {
			if (started) return;
			started = true;
			const boot = () => {
				upgrade(document.body);
				const observer = new MutationObserver(() => { upgrade(document.body); });
				observer.observe(document.body, { childList: true, subtree: true });
				window.__mydshVideoObserver = observer;
			};
			if (document.body) boot();
			else document.addEventListener('DOMContentLoaded', boot, { once: true });
		}

		module.exports = {
			name: '@mydsh/ui-video',
			apply() {
				start();
			},
		};
		return module.exports;
	}
});