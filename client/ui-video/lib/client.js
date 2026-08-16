// mydsh ui-video — 浏览器半边：把消息里引用的本地视频/音频渲染成播放器。
//
// 手写 __ModuleLoader__ bundle（零构建依赖，纯 DOM，不需要 react）。
// 机制：
//   - 在会话内容区挂 MutationObserver：发现指向本地媒体文件的 <a> 链接
//     （href 以 .mp4/.webm/.mov/.m4v/.mkv/.mp3/.wav/.ogg/.flac/.m4a 结尾，
//     且不是 http(s) 外链），就把它替换成 <video controls>（音频则 <audio>），
//     src 指向主机层路由 `/mydsh-media/<encodeURIComponent(绝对路径)>`。
//   - 约定：模型/用户在消息里用绝对路径写媒体链接，例如
//     `[demo.mp4](/home/user/videos/demo.mp4)` 或直接 `[demo.mp4](/home/... )`。
//   - 幂等：已处理过的元素打上标记，不重复替换；新消息到达时自动生效。
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

		function start() {
			if (started) return;
			started = true;
			const boot = () => {
				upgrade(document.body);
				// 增量扫描：只处理 MutationRecord.addedNodes 里的新节点，
				// 不全量 querySelectorAll(body)——长会话下每次 DOM 变化全扫会卡。
				const observer = new MutationObserver((records) => {
					for (const record of records) {
						for (const node of record.addedNodes) {
							if (!node || node.nodeType !== 1) continue;
							upgrade(node);
						}
					}
				});
				observer.observe(document.body, { childList: true, subtree: true });
				window.__mydshVideoObserver = observer;
			};
			if (document.body) boot();
			else document.addEventListener('DOMContentLoaded', boot, { once: true });
		}

		module.exports = {
			name: '@mydsh/ui-video',
			apply(ctx) {
				// 走 ctx.effect 生命周期：插件卸载时框架自动调用 disposer，
				// 断开 MutationObserver，避免旁路到全局变量导致的资源泄漏。
				ctx.effect(() => {
					start();
					return () => {
						try { if (window.__mydshVideoObserver) window.__mydshVideoObserver.disconnect(); } catch {}
						started = false; // 允许重新挂载
					};
				}, '@mydsh/ui-video: observer');
			},
		};
		return module.exports;
	}
});
