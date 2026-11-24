/*
 * Równe Zbieractwo v2.6.1
 * Autor: Mavionis
 *
 * Plac > Zbieractwo masowe: uruchom skrypt. Pojawi się panel z ustawieniami.
 * (Uruchomiony na innym ekranie – przenosi do Zbieractwa masowego.)
 *
 * Zaznaczasz jednostki, a skrypt sam dobiera wspólny zestaw wojsk dla wiosek z aktywnej grupy (wszystkie strony)
 * i dzieli go na poziomy tak, żeby wszystkie oddziały wróciły o tej samej godzinie.
 * Każde kliknięcie skrótu (albo przycisku „Następny krok”) = jedna akcja: wpisuje zestaw kolejnego poziomu
 * w formularz gry i zaznacza jego kolumnę („Zaznacz wszystkie” gry – gra zaznacza tylko wioski, które mają tyle wojsk;
 * skrypt odznacza te, które według planu nie powinny wysyłać, np. przez rezerwę) albo przechodzi na następną stronę.
 * Wysyłasz SAM przyciskiem „Wyślij” gry.
 *
 * Skrypt niczego nie wysyła: nie klika „Wyślij” i nie ustawia na nim kursora. Dane wiosek czyta zwykłymi
 * zapytaniami GET do strony Zbieractwa masowego (tylko odczyt, z przerwą między stronami).
 * Wymaga Konta Premium (Zbieractwo masowe to funkcja premium).
 * Ustawienia z panelu są zapamiętywane w przeglądarce (localStorage), osobno dla każdego konta.
 * Skrypt nie używa ciasteczek i nie łączy się z żadnymi stronami poza serwerem gry.
 */

(function () {
	'use strict';

	const notify = (msg, type, ms) => {
		if (typeof UI !== 'undefined' && UI[type || 'ErrorMessage']) { UI[type || 'ErrorMessage'](msg, ms || 8000); }
		else { alert(String(msg).replace(/<br>/g, '\n').replace(/<[^>]+>/g, '')); }
	};
	if (typeof game_data === 'undefined' || typeof jQuery === 'undefined') {
		notify('Równe Zbieractwo: uruchom skrypt na stronie gry Plemiona (wersja na komputer).');
		return;
	}

	const NAME = 'Równe Zbieractwo';
	const VERSION = 'v2.6.1';
	const NS = 'RowneZbieractwo';
	const FILL_MARGIN = 60;             // s zapasu przy uzupełnianiu (czas od wypełnienia do kliknięcia „Wyślij”)
	const serverNow = () => Math.floor((typeof Timing !== 'undefined' && Timing.getCurrentServerTime ? Timing.getCurrentServerTime() : Date.now()) / 1000);
	const MIN_POP = 10;                 // gra przyjmuje oddział od 10 populacji
	const PLAN_TTL = 30 * 60 * 1000;    // plan starszy niż 30 min trzeba przeliczyć
	const PAGE_DELAY = 250;             // ms przerwy między pobieraniem kolejnych stron (bez zasypywania serwera)
	const SCAV_UNITS = ['spear', 'sword', 'axe', 'archer', 'light', 'marcher', 'heavy', 'knight'];
	const UNIT_NAMES = {
		spear: 'Pikinier', sword: 'Miecznik', axe: 'Topornik', archer: 'Łucznik',
		light: 'Lekki kawalerzysta', marcher: 'Łucznik na koniu', heavy: 'Ciężki kawalerzysta', knight: 'Rycerz'
	};

	const DEFAULTS = {
		units: { spear: false, sword: false, axe: false, archer: false, light: true, marcher: false, heavy: false, knight: false },
		reserve: { spear: 0, sword: 0, axe: 0, archer: 0, light: 0, marcher: 0, heavy: 0, knight: 0 },
		levels: [true, true, true, true],
		mode: 'best',      // 'best' – Optymalnie (najwięcej łupu na godzinę); 'time' – Wróć po; 'fill' – Uzupełnij
		hours: 95 / 60,    // Wróć po: 1:35
		rangeMin: 1,       // Optymalnie: zakres czasu powrotu w godzinach, 0 = bez ograniczenia
		rangeMax: 3,
		tolMin: 3          // uzupełnianie: o ile minut później niż już wysłane może wrócić nowy oddział
	};

	// ---------- Pomocnicze ----------

	const fmt = n => Math.round(n).toLocaleString('pl-PL');
	const fmtTime = s => {
		s = Math.round(s);
		return Math.floor(s / 3600) + ':' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
	};
	const sitterParam = () =>
		(game_data.player.sitter && game_data.player.sitter !== '0') ? '&t=' + game_data.player.id : '';

	const fmtHours = h => { const m = Math.round(h * 60); return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); };
	// Czas w formacie g:mm, np. 1:35 (samo „2” = 2:00); puste → 0, błędne → NaN
	const parseHours = raw => {
		raw = String(raw ?? '').trim();
		if (raw === '') { return 0; }
		const hm = raw.match(/^(\d+)(?::([0-5]\d))?$/);
		return hm ? Number(hm[1]) + Number(hm[2] || 0) / 60 : NaN;
	};
	const storageKey = key => NS + '_' + game_data.player.id + '_' + key;
	function storageGet(key) {
		try { return JSON.parse(localStorage.getItem(storageKey(key))); } catch (e) { return null; }
	}
	function storageSet(key, value) {
		try { localStorage.setItem(storageKey(key), JSON.stringify(value)); } catch (e) { /* brak dostępu */ }
	}
	function storageRemove(key) {
		try { localStorage.removeItem(storageKey(key)); } catch (e) { /* brak dostępu */ }
	}

	function loadSettings() {
		const s = JSON.parse(JSON.stringify(DEFAULTS));
		const saved = storageGet('settings2') || {};
		for (const u of SCAV_UNITS) {
			if (saved.units && typeof saved.units[u] === 'boolean') { s.units[u] = saved.units[u]; }
			if (saved.reserve && Number.isFinite(saved.reserve[u])) { s.reserve[u] = Math.max(0, saved.reserve[u]); }
		}
		if (Array.isArray(saved.levels) && saved.levels.length === 4) { s.levels = saved.levels.map(Boolean); }
		if (['time', 'best', 'fill'].includes(saved.mode)) { s.mode = saved.mode; }
		if (Number.isFinite(saved.hours) && saved.hours >= 5 / 60) { s.hours = saved.hours; } // krótsze = pozostałość starego formatu
		for (const k of ['rangeMin', 'rangeMax']) { if (Number.isFinite(saved[k]) && saved[k] >= 0) { s[k] = saved[k]; } }
		if (Number.isFinite(saved.tolMin) && saved.tolMin >= 0) { s.tolMin = saved.tolMin; }
		return s;
	}

	// ---------- Dane z gry (tylko odczyt) ----------

	// Odczytuje jedną wartość JSON (obiekt, tablicę lub liczbę) z tekstu, zaczynając od pozycji i.
	function readJsonValue(text, i) {
		while (/[\s,]/.test(text[i])) { i++; }
		const start = i;
		if (text[i] === '{' || text[i] === '[') {
			let depth = 0;
			let inString = false;
			for (; i < text.length; i++) {
				const c = text[i];
				if (inString) {
					if (c === '\\') { i++; } else if (c === '"') { inString = false; }
				} else if (c === '"') { inString = true; }
				else if (c === '{' || c === '[') { depth++; }
				else if (c === '}' || c === ']') { depth--; if (depth === 0) { i++; break; } }
			}
			return { value: JSON.parse(text.slice(start, i)), end: i };
		}
		const m = /^-?\d+(\.\d+)?/.exec(text.slice(i));
		if (!m) { throw 'Nieoczekiwany format danych zbieractwa.'; }
		return { value: Number(m[0]), end: i + m[0].length };
	}

	// Strona przekazuje dane do gry jako argumenty new ScavengeMassScreen(poziomy, jednostki, liczba, wioski, ...)
	function parseMassPage(html) {
		const at = html.indexOf('new ScavengeMassScreen(');
		if (at === -1) { throw 'Nie znaleziono danych Zbieractwa masowego.'; }
		let pos = at + 'new ScavengeMassScreen('.length;
		const options = readJsonValue(html, pos); pos = options.end;
		const units = readJsonValue(html, pos); pos = units.end;
		const third = readJsonValue(html, pos); pos = third.end;
		const villages = readJsonValue(html, pos);
		if (!Array.isArray(villages.value)) { throw 'Nieoczekiwany format listy wiosek zbieractwa.'; }
		return { options: options.value, units: units.value, villages: villages.value };
	}

	const currentPage = () => Number((/[?&]page=(\d+)/.exec(location.href) || [])[1] || 0);
	const pageUrl = page => '/game.php?village=' + game_data.village.id + '&screen=place&mode=scavenge_mass&page=' + page + sitterParam();

	// Aktualne wojska wszystkich wiosek aktywnej grupy – wszystkie strony listy (tylko odczyt)
	async function fetchAllPages() {
		let options = null;
		let units = null;
		const villages = [];
		const seen = new Set();
		let pages = 0;
		for (let page = 0; page < 40; page++) {
			if (page > 0) { await new Promise(r => setTimeout(r, PAGE_DELAY)); }
			const html = await $.get(pageUrl(page));
			const data = parseMassPage(html);
			options = options || data.options;
			units = units || data.units;
			// strona bez nowych wiosek = koniec listy (zabezpieczenie przed czytaniem w kółko tej samej strony)
			const fresh = data.villages.filter(v => !seen.has(v.village_id));
			if (!fresh.length) { break; }
			fresh.forEach(v => { seen.add(v.village_id); v._page = page; });
			villages.push(...fresh);
			pages = page + 1;
			if (!/rel="next"/.test(html)) { break; }
		}
		return { options, units, villages, pages };
	}

	// ---------- Obliczenia ----------

	// Czas zbieractwa (s) dla łupu `haul` – wzór gry, parametry z danych poziomu
	const duration = (opt, haul) =>
		(Math.pow(haul * haul * 100, opt.duration_exponent) + opt.duration_initial_seconds) * opt.duration_factor;
	// Łup, przy którym zbieractwo trwa dokładnie `seconds`
	const haulForDuration = (opt, seconds) => {
		const base = seconds / opt.duration_factor - opt.duration_initial_seconds;
		return base > 0 ? Math.sqrt(Math.pow(base, 1 / opt.duration_exponent) / 100) : 0;
	};

	// Plan: wspólny zestaw na każdy poziom (te same liczby dla wszystkich wiosek – tak działa formularz gry).
	// Każdy poziom dostaje tę samą mieszankę w proporcji 1/łup poziomu, więc wszystkie oddziały wracają razem.
	function createPlan(data, settings) {
		const unitIds = SCAV_UNITS.filter(u => settings.units[u] && data.units[u] && data.units[u].carry > 0);
		if (!unitIds.length) { throw 'Zaznacz co najmniej jedną jednostkę.'; }
		const levels = [1, 2, 3, 4].filter(id => settings.levels[id - 1] && data.options[id]);
		if (!levels.length) { throw 'Zaznacz co najmniej jeden poziom.'; }

		const villages = data.villages.filter(v => v.has_rally_point).map(v => {
			const avail = {};
			for (const u of unitIds) { avail[u] = Math.max(0, (v.unit_counts_home[u] || 0) - (settings.reserve[u] || 0)); }
			const free = levels.filter(id => {
				const st = v.options[id];
				return st && !st.is_locked && !st.unlock_time && !st.scavenging_squad;
			});
			return { v, avail, free };
		});
		const active = villages.filter(x => x.free.length && unitIds.some(u => x.avail[u] > 0));
		if (!active.length) { throw 'W tej grupie żadna wioska nie ma wolnego poziomu i wojsk do wysłania.'; }

		const carryOf = (t, units) => units.reduce((a, u) => a + (t[u] || 0) * data.units[u].carry, 0);
		const popOf = (t, units) => units.reduce((a, u) => a + (t[u] || 0) * data.units[u].pop, 0);

		// Kandydaci na mieszankę: percentyle liczby jednostek w wioskach (od słabszych do najsilniejszej).
		// Mediana bywa za mała, gdy wiosek jest mało albo są bardzo różne – wybór robi symulacja.
		const pct = (arr, q) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1) + 0.5))]; };
		const mixesFor = pool => {
			const out = [];
			for (const q of [0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
				const m = {};
				for (const u of unitIds) { m[u] = pct(pool.map(x => x.avail[u]), q); }
				if (unitIds.some(u => m[u] > 0) && !out.some(o => unitIds.every(u => o[u] === m[u]))) { out.push(m); }
			}
			return out;
		};

		// Przeszukanie: poziomy × mieszanki × wielkość zestawu.
		// targetSec ustawione → zestaw na zadany czas (wynik: najwięcej łupu); brak → najwięcej łupu na godzinę.
		const search = (pool, targetSec, range) => {
			let found = null;
			let tooShort = false;
			const simulate = (templates, units, record) => {
				let loot = 0;
				const counts = templates.map(() => 0);
				const sends = record ? templates.map(() => []) : null;
				for (const x of pool) {
					const rest = Object.assign({}, x.avail);
					const cf = x.v.unit_carry_factor || 1;
					templates.forEach((tp, i) => {
						if (!x.free.includes(tp.optionId)) { return; }
						if (units.some(u => rest[u] < tp.units[u])) { return; }
						units.forEach(u => { rest[u] -= tp.units[u]; });
						counts[i]++;
						if (sends) { sends[i].push(x.v.village_id); }
						loot += carryOf(tp.units, units) * cf * data.options[tp.optionId].loot_factor;
					});
				}
				// poziomy wracają razem, ale zaokrąglenie liczby jednostek daje kilka sekund różnicy – podajemy najdłuższy
				const seconds = Math.max(...templates.map(tp => duration(data.options[tp.optionId], carryOf(tp.units, units) * data.options[tp.optionId].loot_factor)));
				return { loot, counts, seconds, sends };
			};
			const poolMixes = mixesFor(pool);
			const poolLevels = levels.filter(id => pool.some(x => x.free.includes(id)));
			for (let mask = 1; mask < (1 << poolLevels.length); mask++) {
				const lv = poolLevels.filter((_, i) => mask & (1 << i));
				const invSum = lv.reduce((t, id) => t + 1 / data.options[id].loot_factor, 0);
				const share = id => (1 / data.options[id].loot_factor) / invSum;
				for (const m of poolMixes) {
					const units = unitIds.filter(u => m[u] > 0);
					// s = 1 → wioska z tą mieszanką wysyła wszystkie zaznaczone jednostki
					const templatesFor = sc => lv.map(id => {
						const t = {};
						for (const u of units) { t[u] = Math.floor(m[u] * sc * share(id)); }
						return { optionId: id, units: t };
					});
					const consider = (sc, tps) => {
						if (!tps.every(tp => popOf(tp.units, units) >= MIN_POP)) { return; }
						const r = simulate(tps, units);
						if (!r.loot) { return; }
						const perHour = r.loot / (r.seconds / 3600);
						if (!targetSec && range && (r.seconds < range[0] || r.seconds > range[1])) { return; }
						const score = targetSec ? r.loot : perHour;
						if (!found || score > found.score) { found = { s: sc, templates: tps, perHour, score, usedUnits: units, ...simulate(tps, units, true) }; }
					};
					if (targetSec) {
						const opt = data.options[lv[0]];
						const haul = haulForDuration(opt, targetSec);
						if (haul <= 0) { tooShort = true; continue; }
						const sc = haul / (opt.loot_factor * share(lv[0]) * carryOf(m, units));
						consider(sc, templatesFor(sc));
					} else {
						for (let k = 0; k <= 120; k++) {
							const sc = 0.05 * Math.pow(20, k / 120); // 0,05 … 1
							consider(sc, templatesFor(sc));
						}
					}
				}
			}
			return { found, tooShort };
		};

		let best = null;
		let limits = null;
		if (settings.mode === 'fill') {
			// Uzupełnianie: nowe oddziały wracają nie później niż te, które już są na zbieractwie w danej wiosce
			const now = serverNow();
			limits = {};
			for (const x of active) {
				const ret = Object.values(x.v.options || {}).map(o => o && o.scavenging_squad && o.scavenging_squad.return_time).filter(Boolean);
				if (ret.length) { limits[x.v.village_id] = Math.max(...ret); }
			}
			const tolSec = settings.tolMin * 60;
			const allowed = t => t - now - FILL_MARGIN + tolSec;
			const left = Object.values(limits).map(allowed).filter(t => t > 0).sort((p, q) => p - q);
			if (!left.length) { throw 'W tej grupie nic nie jest teraz na zbieractwie – wybierz „Optymalnie” albo „Wróć po”.'; }
			// kandydaci na wspólny czas: pozostałe czasy powrotu wiosek (najwyżej ok. 40 wartości)
			const step = Math.max(1, Math.floor(left.length / 40));
			const cands = [...new Set(left.filter((_, i) => i % step === 0).concat(left[left.length - 1]))];
			for (const T of cands) {
				const pool = active.filter(x => !limits[x.v.village_id] || allowed(limits[x.v.village_id]) >= T);
				const r = search(pool, T).found;
				if (r && (!best || r.loot > best.loot)) { best = r; }
			}
			if (!best) {
				// szczegóły, żeby było widać, czego brakuje: wojsk w domu czy czasu
				const maxLeft = left[left.length - 1];
				const homePop = Math.max(...active.map(x => unitIds.reduce((a, u) => a + x.avail[u] * data.units[u].pop, 0)));
				throw `Nie da się uzupełnić – najwięcej wolnych zaznaczonych wojsk w jednej wiosce: ${fmt(homePop)} populacji, ` +
					`najdłuższy dopuszczalny powrót (już wysłane + tolerancja) za ${fmtTime(maxLeft + FILL_MARGIN)}. ` +
					'W tym czasie nie zmieści się oddział min. 10 populacji na wolny poziom.';
			}
		} else if (settings.mode === 'time') {
			if (settings.hoursValid === false) { throw 'Nieprawidłowy czas – wpisz w formacie g:mm, np. 1:35.'; }
			const r = search(active, settings.hours * 3600);
			best = r.found;
			if (!best) {
				throw r.tooShort
					? 'Zadany czas jest za krótki – minimum to ok. ' + fmtTime(duration(data.options[levels[0]], 0)) + '.'
					: 'Przy tym czasie nie da się złożyć oddziału min. 10 populacji – wydłuż czas.';
			}
		} else {
			const lo = settings.rangeMin, hi = settings.rangeMax;
			if (Number.isNaN(lo) || Number.isNaN(hi)) { throw 'Nieprawidłowy zakres czasu – wpisz w formacie g:mm, np. 1:00 i 2:30 (puste pole = bez ograniczenia).'; }
			if (lo && hi && lo > hi) { throw 'Zakres czasu: „od” jest większe niż „do”.'; }
			const range = lo || hi ? [lo ? lo * 3600 : 0, hi ? hi * 3600 : Infinity] : null;
			best = search(active, 0, range).found;
			if (!best) {
				throw range
					? 'W tym zakresie czasu nie da się złożyć zestawu – przy tych wojskach zmniejsz „od” albo zwiększ „do”.'
					: 'Za mało wojsk – żadna wioska nie złoży oddziału min. 10 populacji.';
			}
		}
		best.limits = limits;
		// które wioski wysyłają na który poziom (wg planu) – pozostałe skrypt odznacza przy wypełnianiu
		best.allowed = {};
		best.templates.forEach((tp, i) => { best.allowed[tp.optionId] = best.sends[i]; });
		delete best.sends;
		best.opts = {};
		levels.forEach(id => {
			const o = data.options[id];
			best.opts[id] = { loot_factor: o.loot_factor, duration_exponent: o.duration_exponent, duration_initial_seconds: o.duration_initial_seconds, duration_factor: o.duration_factor };
		});
		best.carry = {};
		unitIds.forEach(u => { best.carry[u] = data.units[u].carry; });
		best.cf = {};
		active.forEach(x => { if ((x.v.unit_carry_factor || 1) !== 1) { best.cf[x.v.village_id] = x.v.unit_carry_factor; } });
		best.tolSec = settings.mode === 'fill' ? settings.tolMin * 60 : 0;
		// poziomy, na które żadna wioska nie wyśle, wypadają z planu (pozostałe i tak wracają razem)
		const keep = best.counts.map(c => c > 0);
		best.templates = best.templates.filter((_, i) => keep[i]);
		best.counts = best.counts.filter((_, i) => keep[i]);
		const usedUnits = best.usedUnits;
		const droppedUnits = unitIds.filter(u => !usedUnits.includes(u));
		return { ...best, usedUnits, droppedUnits, skippedLevels: levels.filter(id => !best.templates.some(t => t.optionId === id)), villageCount: active.length, pages: data.pages || 1 };
	}

	// ---------- Formularz gry ----------

	function setInput(input, value) {
		$(input).val(value === '' ? '' : String(value));
		['input', 'keyup', 'change'].forEach(ev => input.dispatchEvent(new Event(ev, { bubbles: true })));
	}

	// Wpisuje zestaw poziomu w wiersz wojsk gry i zaznacza kolumnę poziomu („Zaznacz wszystkie” gry).
	// Wcześniej odznacza wszystko inne, żeby z tym zestawem nie poszedł inny poziom.
	async function fillLevel(template, plan) {
		const screen = $('#scavenge_mass_screen');
		const inputs = screen.find('.candidate-squad-widget input.unitsInput');
		if (!inputs.length) { throw 'Nie znaleziono formularza Zbieractwa masowego na tej stronie.'; }
		// odznacz wszystko: najpierw „Zaznacz wszystkie” (gra odznacza wtedy całą kolumnę), potem pojedyncze wioski
		screen.find('.mass-scavenge-table input.select-all-col:checked').each(function () { $(this).trigger('click'); });
		screen.find('.mass-scavenge-table td[class*="option-"] input[type=checkbox]:checked').each(function () { $(this).trigger('click'); });
		inputs.each(function () { setInput(this, template.units[this.name] ? template.units[this.name] : ''); });
		// gra odblokowuje pola wyboru dopiero po przeliczeniu wpisanego zestawu – czekamy do 1,5 s
		const colBox = () => screen.find(`.select-all-col[data-option="${template.optionId}"]`);
		if (!colBox().length) { throw 'Nie znaleziono kolumny poziomu ' + template.optionId + '.'; }
		for (let i = 0; i < 15 && colBox().prop('disabled'); i++) { await new Promise(r => setTimeout(r, 100)); }
		if (colBox().prop('disabled')) { return 0; }
		colBox().trigger('click');
		// gra zaznacza każdą wioskę, która ma tyle wojsk; odznaczamy te, które wg planu nie wysyłają na ten poziom
		// (rezerwa „Zostaw w wiosce”, kolejność poziomów) oraz – w trybie Uzupełnij – te, które wróciłyby za późno
		const allowed = plan && plan.allowed && plan.allowed[template.optionId] ? new Set(plan.allowed[template.optionId].map(Number)) : null;
		const opt = plan && plan.opts ? plan.opts[template.optionId] : null;
		const carry = Object.keys(template.units).reduce((a, u) => a + template.units[u] * ((plan && plan.carry && plan.carry[u]) || 0), 0);
		screen.find(`.mass-scavenge-table td.option-${template.optionId} input[type=checkbox]:checked`).each(function () {
			const id = Number($(this).closest('tr').data('id'));
			let ok = !allowed || allowed.has(id);
			if (ok && plan && plan.limits && plan.limits[id] && opt) {
				const cf = (plan.cf && plan.cf[id]) || 1; // premia ładowności – liczona ostrożnie, jakby wydłużała zbieractwo
				const end = serverNow() + duration(opt, carry * cf * opt.loot_factor) + FILL_MARGIN;
				ok = end <= plan.limits[id] + (plan.tolSec || 0);
			}
			if (!ok) { $(this).trigger('click'); }
		});
		// tylko przewinięcie widoku do tabeli i przycisku „Wyślij” (nad tabelą) – bez kursora na przycisku
		const table = screen.find('.mass-scavenge-table');
		if (table.length) { window.scrollTo({ top: Math.max(0, table.offset().top - 160), behavior: 'smooth' }); }
		return screen.find(`.mass-scavenge-table td.option-${template.optionId} input[type=checkbox]:checked`).length;
	}

	// Czy w kolumnie poziomu są jeszcze zaznaczone wioski (czyli nie kliknięto „Wyślij”)
	const stillTicked = optionId =>
		$(`#scavenge_mass_screen .mass-scavenge-table td.option-${optionId} input[type=checkbox]:checked`).length > 0;

	// ---------- Kolejne kroki (1 kliknięcie = 1 akcja) ----------

	function loadPlan() {
		const plan = storageGet('plan2');
		if (!plan || !plan.templates || Date.now() - plan.time > PLAN_TTL) { return null; }
		return plan;
	}

	async function nextStep() {
		const plan = loadPlan();
		if (!plan) { notify(NAME + ': brak aktualnego planu – kliknij „Oblicz zestaw”.'); return; }
		const step = plan.step;
		if (currentPage() !== step.page) { location.href = pageUrl(step.page); return; }

		// poprzedni poziom wypełniony, ale niewysłany – nie nadpisujemy go
		if (step.idx > 0 && step.idx <= plan.templates.length && stillTicked(plan.templates[step.idx - 1].optionId)) {
			notify(`${NAME}: najpierw kliknij „Wyślij” dla poziomu ${plan.templates[step.idx - 1].optionId}.`);
			return;
		}
		if (step.idx < plan.templates.length) {
			const tp = plan.templates[step.idx];
			const ticked = await fillLevel(tp, plan);
			step.idx++;
			storageSet('plan2', plan);
			renderProgress(plan);
			notify(ticked
				? `${NAME}: strona ${step.page + 1}, poziom ${tp.optionId} – zaznaczono wiosek: ${ticked}. Sprawdź i kliknij „Wyślij”.`
				: `${NAME}: strona ${step.page + 1}, poziom ${tp.optionId} – żadna wioska nie ma tego zestawu. Kliknij skrót dla następnego kroku.`,
			ticked ? 'SuccessMessage' : 'ErrorMessage');
			return;
		}
		const order = plan.order || Array.from({ length: plan.pages }, (_, i) => i);
		const pos = step.pos || 0;
		if (pos + 1 < order.length) {
			plan.step = { page: order[pos + 1], pos: pos + 1, idx: 0 };
			storageSet('plan2', plan);
			location.href = pageUrl(plan.step.page);
			return;
		}
		storageRemove('plan2');
		renderProgress(null);
		notify(NAME + ': gotowe – wszystkie strony wypełnione.', 'SuccessMessage');
	}

	// ---------- Panel ----------

	function unitIcon(u) {
		return `<img src="${image_base}unit/unit_${u}.png" style="vertical-align:middle">`;
	}
	const unitsText = t => Object.keys(t).filter(u => t[u] > 0).map(u => `${unitIcon(u)}${fmt(t[u])}`).join(' ');

	function readPanel() {
		const s = JSON.parse(JSON.stringify(DEFAULTS));
		for (const u of SCAV_UNITS) {
			s.units[u] = $(`#${NS}_unit_${u}`).is(':checked');
			const raw = String($(`#${NS}_reserve_${u}`).val() ?? '').trim();
			s.reserve[u] = raw === '' ? 0 : Math.max(0, Math.floor(Number(raw)) || 0);
		}
		s.levels = [1, 2, 3, 4].map(i => $(`#${NS}_level_${i}`).is(':checked'));
		s.mode = $(`input[name=${NS}_mode]:checked`).val() || 'best';
		const hours = parseHours($(`#${NS}_hours`).val());
		s.hours = hours > 0 ? hours : DEFAULTS.hours;
		s.hoursValid = hours > 0;
		// zakres czasu powrotu w trybie Optymalnie (puste pole = bez ograniczenia)
		s.rangeMin = parseHours($(`#${NS}_rmin`).val());
		s.rangeMax = parseHours($(`#${NS}_rmax`).val());
		const tol = Number(String($(`#${NS}_tol`).val() ?? '').replace(',', '.'));
		s.tolMin = tol >= 0 ? tol : DEFAULTS.tolMin;
		return s;
	}

	function renderPanel(settings) {
		const units = SCAV_UNITS.filter(u => game_data.units.includes(u));
		const unitRows = units.map(u => `
			<tr><td>${unitIcon(u)} ${UNIT_NAMES[u]}</td>
				<td style="text-align:center"><input type="checkbox" id="${NS}_unit_${u}" ${settings.units[u] ? 'checked' : ''}></td>
				<td><input type="number" min="0" id="${NS}_reserve_${u}" value="${settings.reserve[u]}" style="width:70px"></td></tr>`).join('');
		const levelBoxes = [1, 2, 3, 4].map(i =>
			`<label style="display:inline-block;white-space:nowrap;margin-right:14px"><input type="checkbox" id="${NS}_level_${i}" ${settings.levels[i - 1] ? 'checked' : ''}> ${i}</label>`).join('');

		$('#content_value').prepend(`
		<div id="${NS}" class="vis vis_item" style="margin-bottom:10px;padding:8px">
			<h3 style="margin:0 0 6px 0">${NAME} <small>${VERSION}</small></h3>
			<p style="margin:0 0 8px 0">Zaznacz jednostki – skrypt sam dobierze zestaw dla wiosek z aktywnej grupy (wszystkie strony) i podzieli go na poziomy tak,
			żeby wszystko wróciło o jednej godzinie. Wypełnia formularz gry, a „Wyślij” klikasz sam.</p>
			<table class="vis" style="width:100%">
				<tr><th>Jednostka</th><th>Wysyłaj</th><th>Zostaw w wiosce</th></tr>
				${unitRows}
				<tr><th colspan="3">Poziomy i czas</th></tr>
				<tr><td>Poziomy</td><td colspan="2"><div style="white-space:nowrap">${levelBoxes}</div>
					<small>oddział musi mieć min. 10 populacji – przy małej liczbie wojsk skrypt sam pominie poziomy, które się nie opłacają</small></td></tr>
				<tr><td style="vertical-align:top">Tryb</td><td colspan="2">
					<div style="margin:2px 0 8px 0">
						<label><input type="radio" name="${NS}_mode" value="best" ${settings.mode === 'best' ? 'checked' : ''}> <b>Optymalnie</b></label>
						<input type="text" id="${NS}_rmin" value="${settings.rangeMin ? fmtHours(settings.rangeMin) : ''}" placeholder="g:mm" style="width:45px">–<input type="text" id="${NS}_rmax" value="${settings.rangeMax ? fmtHours(settings.rangeMax) : ''}" placeholder="g:mm" style="width:45px">
						<br><small>skrypt sam dobiera zestaw i czas powrotu (najwięcej surowców na godzinę) w zakresie od–do; puste pole = bez ograniczenia</small>
					</div>
					<div style="margin:0 0 8px 0">
						<label><input type="radio" name="${NS}_mode" value="time" ${settings.mode === 'time' ? 'checked' : ''}> <b>Wróć po</b></label>
						<input type="text" id="${NS}_hours" value="${fmtHours(settings.hours)}" placeholder="g:mm" style="width:45px">
						<br><small>wszystkie oddziały wracają po zadanym czasie, np. 1:35</small>
					</div>
					<div style="margin:0">
						<label><input type="radio" name="${NS}_mode" value="fill" ${settings.mode === 'fill' ? 'checked' : ''}> <b>Uzupełnij</b></label>
						+<input type="text" id="${NS}_tol" value="${settings.tolMin}" style="width:35px"> min
						<br><small>wypełnia wolne poziomy tak, żeby nowe oddziały wróciły razem z już wysłanymi – najwyżej o tyle minut później (0 = nie później)</small>
					</div></td></tr>
			</table>
			<div id="${NS}_warn" style="margin-top:6px;color:#c00;font-weight:bold"></div>
			<div style="margin-top:8px"><input type="button" class="btn" id="${NS}_calc" value="Oblicz zestaw"></div>
			<div id="${NS}_plan" style="margin-top:8px"></div>
		</div>`);

		const update = () => {
			const s = readPanel();
			storageSet('settings2', s);
			const noReserve = units.filter(u => s.units[u] && !s.reserve[u]).map(u => UNIT_NAMES[u]);
			$('#' + NS + '_warn').html(noReserve.length
				? `Uwaga: bez rezerwy (${noReserve.join(', ')}) – zestaw może zabrać te jednostki w całości, także z wiosek atakowanych. ` +
				'Wpisz „Zostaw w wiosce” albo wybierz grupę bez atakowanych wiosek.'
				: '');
		};
		$('#' + NS).on('input change', 'input', update);
		update();
	}

	function renderPlan(plan) {
		const rows = plan.templates.map((tp, i) =>
			`<tr><td>Poziom ${tp.optionId}</td><td>${unitsText(tp.units)}</td><td>${plan.counts[i]} z ${plan.villageCount}</td></tr>`).join('');
		$('#' + NS + '_plan').html(`
			<p>${plan.limits ? 'Nowe oddziały wrócą po ok.' : 'Wszystkie oddziały wrócą po ok.'} <b>${fmtTime(plan.seconds)}</b>${plan.limits ? ' – mniej więcej razem z tymi, które już są na zbieractwie' : ''}. Łup: <b>${fmt(plan.loot)}</b> surowców
			(${plan.pages > 1 ? 'wszystkie strony: ' + plan.pages : '1 strona'}).
			${plan.droppedUnits.length ? `<br><small>Pominięte jednostki (za mało ich w wioskach): ${plan.droppedUnits.map(u => UNIT_NAMES[u]).join(', ')}.</small>` : ''}${plan.skippedLevels && plan.skippedLevels.length ? `<br><small>Pominięte poziomy (za mało wojsk albo mniej łupu): ${plan.skippedLevels.join(', ')}.</small>` : ''}</p>
			<table class="vis" style="width:100%">
				<tr><th>Poziom</th><th>Zestaw (każda wioska)</th><th>Wiosek wyśle</th></tr>${rows}
			</table>
			<p style="margin-top:6px"><input type="button" class="btn" id="${NS}_next" value="Następny krok">
			<span id="${NS}_progress" style="margin-left:8px"></span></p>
			<small>Każde kliknięcie skrótu (albo „Następny krok”) wypełnia kolejny poziom albo przechodzi na następną stronę.
			Po każdym wypełnieniu sprawdź i kliknij „Wyślij” gry.</small>`);
		renderProgress(plan);
	}

	function renderProgress(plan) {
		const el = $('#' + NS + '_progress');
		if (!plan) { el.html('<b>Gotowe.</b>'); $(`#${NS}_next, #${NS}_next2`).addClass('btn-disabled'); return; }
		const { page, idx } = plan.step;
		const order = plan.order || Array.from({ length: plan.pages }, (_, i) => i);
		const pos = plan.step.pos || 0;
		const what = idx < plan.templates.length
			? `wypełnienie poziomu ${plan.templates[idx].optionId}`
			: (pos + 1 < order.length ? `przejście na stronę ${order[pos + 1] + 1}` : 'koniec');
		el.html(`Następnie: <b>${what}</b> (strona ${page + 1}; ${pos + 1}. z ${plan.pages})`);
	}

	// Jeden krok naraz – skrót, „Następny krok” i przycisk pod „Wyślij” nie mogą wypełniać jednocześnie
	async function runStep() {
		if (window[NS + '_busy']) { return; }
		window[NS + '_busy'] = true;
		try { await nextStep(); }
		catch (ex) { notify(NAME + ': ' + (typeof ex === 'string' ? ex : 'nie udało się wypełnić formularza.')); }
		finally { window[NS + '_busy'] = false; }
	}

	// ---------- Start ----------

	try {
		// skrót wykonany dwa razy tuż po sobie (zdarza się w grze) liczy się jako jedno kliknięcie
		if (Date.now() - (window[NS + '_lastRun'] || 0) < 1500) { return; }
		window[NS + '_lastRun'] = Date.now();

		// Gra potrafi wyzerować game_data.mode w tle, więc ekran rozpoznajemy też po adresie i treści strony
		const onMassScreen = game_data.screen === 'place' && (game_data.mode === 'scavenge_mass' ||
			/[?&]mode=scavenge_mass(&|$)/.test(location.href) || $('#scavenge_mass_screen').length > 0);
		if (!onMassScreen) {
			const plan = loadPlan();
			location.href = pageUrl(plan ? plan.step.page : 0);
			return;
		}
		const premium = game_data.features && game_data.features.Premium;
		if (!premium || !premium.active) {
			notify(NAME + ': Zbieractwo masowe wymaga aktywnego Konta Premium.');
			return;
		}

		// panel już otwarty → skrót wykonuje następny krok planu
		if ($('#' + NS).length) {
			if (loadPlan()) { runStep(); }
			else { notify(NAME + ': kliknij „Oblicz zestaw”.', 'InfoMessage'); }
			return;
		}

		renderPanel(loadSettings());
		let busy = false;
		let existing = loadPlan();
		// zakończony plan z poprzedniego użycia – usuwamy po cichu, bez komunikatu „gotowe”
		if (existing && existing.step.idx >= existing.templates.length && (existing.step.pos || 0) + 1 >= (existing.order || [0]).length) {
			storageRemove('plan2');
			existing = null;
		}
		if (existing) {
			renderPlan(existing);
			runStep(); // np. po przejściu na następną stronę
		}

		$('#' + NS + '_calc').on('click', async () => {
			if (busy) { return; }
			busy = true;
			$('#' + NS + '_plan').html('<i>Pobieranie aktualnych wojsk ze wszystkich stron…</i>');
			try {
				const plan = createPlan(await fetchAllPages(), readPanel());
				plan.time = Date.now();
				const cur = currentPage() < plan.pages ? currentPage() : 0;
				plan.order = [cur, ...Array.from({ length: plan.pages }, (_, i) => i).filter(i => i !== cur)];
				plan.step = { page: cur, pos: 0, idx: 0 };
				storageSet('plan2', plan);
				renderPlan(plan);
			} catch (ex) {
				$('#' + NS + '_plan').html('');
				storageRemove('plan2');
				notify(NAME + ': ' + (typeof ex === 'string' ? ex : 'nie udało się pobrać danych z gry – spróbuj ponownie.'));
			} finally {
				busy = false;
			}
		});

		// drugi przycisk „Następny krok” tuż pod „Wyślij” gry – po wysłaniu nie trzeba wracać do skrótu na górze
		const sendRow = $('#scavenge_mass_screen .send-row').first();
		if (sendRow.length && !$('#' + NS + '_next2').length) {
			sendRow.after(`<div style="margin:6px 0;text-align:right"><input type="button" class="btn" id="${NS}_next2" value="Równe Zbieractwo: następny krok"></div>`);
		}
		$(document).on('click', `#${NS}_next, #${NS}_next2`, runStep);
	} catch (ex) {
		notify(NAME + ' ' + VERSION + ': błąd – ' + (ex && ex.message ? ex.message : ex));
		console.error(NAME, ex);
	}
})();
