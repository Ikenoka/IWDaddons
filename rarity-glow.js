/*
 * DG Rarity Glow — Isleward addon
 *
 * Draws a glow around each item's sprite in its rarity colour (inventory,
 * equipment, and any other slot the game renders through renderItem).
 * Standalone: it doesn't depend on the DG Radiant Items or DG Perf Tiers addons.
 */
(function () {
	// ---- Settings -----------------------------------------------------------
	// Isleward item.quality: 0 common, 1 magic, 2 rare, 3 epic, 4 legendary.
	// NOTE: these hex values are from memory of Isleward's palette - if a shade looks off
	// next to the game's own tooltip colours, tweak it here.
	const ENABLED = true;
	const GLOW_COMMON = false;    // set true to also glow common (white) items
	const COLORS = {
		0: '#fcfcfc',   // common    - white
		1: '#51fc9a',   // magic     - green
		2: '#3fa7dd',   // rare      - blue
		3: '#a24eff',   // epic      - purple
		4: '#ff6942'    // legendary - orange
	};

	// ---- Selectors (adjust here if the game's DOM changes) ------------------
	const SEL_SLOT = '.renderItem.item';
	// -------------------------------------------------------------------------

	const CSS = `
	${SEL_SLOT}.dgQuality .icon {
		filter: drop-shadow(0 0 1px var(--dg-q)) drop-shadow(0 0 3px var(--dg-q)) drop-shadow(0 0 5px var(--dg-q));
	}
	`;

	function defer(method) {
		if (window.$ && window.addons) method();
		else setTimeout(() => defer(method), 50);
	}

	function injectCss() {
		if (document.getElementById('dgRarityGlowStyle')) return;
		const style = document.createElement('style');
		style.id = 'dgRarityGlowStyle';
		style.textContent = CSS;
		document.head.appendChild(style);
	}

	function qualityColor(item) {
		if (!ENABLED || !item) return null;
		const q = Number(item.quality);
		if (!Number.isFinite(q)) return null;
		if (q === 0 && !GLOW_COMMON) return null;
		return COLORS[q] || null;
	}

	function applyGlow(el, item) {
		if (!el) return;
		const color = qualityColor(item);
		const $el = window.$(el);
		if (color) {
			$el.addClass('dgQuality');
			el.style.setProperty('--dg-q', color);
		} else {
			$el.removeClass('dgQuality');
			el.style.removeProperty('--dg-q');
		}
	}

	// Fallback for slots the game's 'beforeRenderItem' event didn't cover, plus cleanup:
	// when an item leaves a slot the game re-renders it as 'empty' without emitting that event.
	function reconcile() {
		window.$(SEL_SLOT).each(function () {
			const $el = window.$(this);
			if (this.classList.contains('empty')) {
				if (this.classList.contains('dgQuality')) applyGlow(this, null);
				return;
			}
			if (this.classList.contains('dgQuality')) return;
			const item = $el.data('item') || $el.find('.icon').data('item');
			if (item && typeof item === 'object') applyGlow(this, item);
		});
	}

	function watchSlots() {
		const root = document.querySelector('.ui-container') || document.body;
		let pending = false;
		const obs = new MutationObserver(() => {
			if (pending) return;
			pending = true;
			requestAnimationFrame(() => {
				pending = false;
				reconcile();
			});
		});
		obs.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
	}

	// ---- Addon registration -------------------------------------------------
	defer(() => {
		injectCss();
		watchSlots();

		window.addons.register({
			init: function ({ events }) {
				// Emitted by renderItem for every item slot, with { el, item }.
				events.on('beforeRenderItem', this.onBeforeRenderItem.bind(this));
			},

			onBeforeRenderItem: function (obj) {
				if (!obj || !obj.el || !obj.item) return;
				const { el, item } = obj;
				applyGlow(el[0], item);
			}
		});
	});
})();
