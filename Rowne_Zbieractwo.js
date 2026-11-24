/*
 * Równe Zbieractwo v1.0.8
 * Autor: Mavionis
 *
 * Plac > Zbieractwo masowe: uruchom skrypt. Pojawi się panel z ustawieniami.
 * (Uruchomiony na innym ekranie – przenosi do Zbieractwa masowego.)
 *
 * „Oblicz plan” – skrypt czyta wioski z aktywnej grupy (wszystkie strony listy) i dla KAŻDEJ wioski
 * osobno dzieli wybrane jednostki na wolne poziomy zbieractwa tak, żeby wszystkie oddziały
 * wróciły w tym samym czasie (albo po zadanym czasie). Nic nie wysyła.
 * „Wyślij partię” – jedno kliknięcie wysyła jedną partię (do 50 wiosek), tak jak przycisk „Wyślij” gry.
 *
 * Nigdy nie używa płatnego bonusu +20% (punkty premium).
 * Ustawienia z panelu są zapamiętywane w przeglądarce (localStorage), osobno dla każdego konta.
 * Skrypt nie używa ciasteczek i nie łączy się z żadnymi stronami poza serwerem gry.
 */

(async function () {
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
	const VERSION = 'v1.0.8';
	const NS = 'RowneZbieractwo';
	const BATCH_VILLAGES = 50;          // tyle wiosek, ile gra pokazuje na jednej stronie Zbieractwa masowego
	const MIN_POP = 10;                 // gra przyjmuje oddział od 10 populacji
	const PLAN_TTL = 10 * 60 * 1000;    // plan starszy niż 10 min trzeba przeliczyć (wojska mogły się zmienić)
	const SCAV_UNITS = ['spear', 'sword', 'axe', 'archer', 'light', 'marcher', 'heavy', 'knight'];
	const UNIT_NAMES = {
		spear: 'Pikinier', sword: 'Miecznik', axe: 'Topornik', archer: 'Łucznik',
		light: 'Lekki kawalerzysta', marcher: 'Łucznik na koniu', heavy: 'Ciężki kawalerzysta', knight: 'Rycerz'
	};

	const DEFAULTS = {
		units: { spear: false, sword: false, axe: false, archer: false, light: true, marcher: false, heavy: false, knight: false },
		reserve: { spear: 0, sword: 0, axe: 0, archer: 0, light: 0, marcher: 0, heavy: 0, knight: 0 },
		levels: [true, true, true, true],
		mode: 'equal',     // 'equal' – wszystkie dostępne wojska, równy powrót; 'time' – tylko tyle, ile trzeba na zadany czas
		hours: 1
	};

	// ---------- Pomocnicze ----------

	const fmt = n => Math.round(n).toLocaleString('pl-PL');
	const esc = t => $('<div>').text(t).html();
	const fmtTime = s => {
		s = Math.round(s);
		return Math.floor(s / 3600) + ':' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
	};
	const sitterParam = () =>
		(game_data.player.sitter && game_data.player.sitter !== '0') ? '&t=' + game_data.player.id : '';

	const storageKey = key => NS + '_' + game_data.player.id + '_' + key;
	function storageGet(key) {
		try { return JSON.parse(localStorage.getItem(storageKey(key))); } catch (e) { return null; }
	}
	function storageSet(key, value) {
		try { localStorage.setItem(storageKey(key), JSON.stringify(value)); } catch (e) { /* brak dostępu */ }
	}

	function loadSettings() {
		const s = JSON.parse(JSON.stringify(DEFAULTS));
		const saved = storageGet('settings') || {};
		for (const u of SCAV_UNITS) {
			if (saved.units && typeof saved.units[u] === 'boolean') { s.units[u] = saved.units[u]; }
			if (saved.reserve && Number.isFinite(saved.reserve[u])) { s.reserve[u] = Math.max(0, saved.reserve[u]); }
		}
		if (Array.isArray(saved.levels) && saved.levels.length === 4) { s.levels = saved.levels.map(Boolean); }
		if (saved.mode === 'time' || saved.mode === 'equal') { s.mode = saved.mode; }
		if (Number.isFinite(saved.hours) && saved.hours > 0) { s.hours = saved.hours; }
		return s;
	}

	// ---------- Dane z gry ----------

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

	// Strona Zbieractwa masowego przekazuje dane do gry jako argumenty new ScavengeMassScreen(opcje, jednostki, liczba, wioski, ...)
	function parseMassPage(html) {
		const at = html.indexOf('new ScavengeMassScreen(');
		if (at === -1) {
			const premium = game_data.features && game_data.features.Premium;
			throw 'Nie znaleziono danych Zbieractwa masowego.' + (premium && !premium.active ? ' Ten widok wymaga Konta Premium.' : '');
		}
		let pos = at + 'new ScavengeMassScreen('.length;
		const options = readJsonValue(html, pos); pos = options.end;
		const units = readJsonValue(html, pos); pos = units.end;
		const third = readJsonValue(html, pos); pos = third.end;
		const villages = readJsonValue(html, pos);
		if (!Array.isArray(villages.value)) { throw 'Nieoczekiwany format listy wiosek zbieractwa.'; }
		return {
			options: options.value,
			units: units.value,
			villages: villages.value,
			hasNext: /rel="next"/.test(html)
		};
	}

	// Pobiera wszystkie strony listy (aktywna grupa, jak na ekranie gry) – tylko odczyt
	async function fetchAll() {
		let options = null;
		let units = null;
		const villages = [];
		const seen = new Set();
		for (let page = 0; page < 40; page++) {
			const html = await $.get('/game.php?village=' + game_data.village.id + '&screen=place&mode=scavenge_mass&page=' + page + sitterParam());
			const data = parseMassPage(html);
			options = options || data.options;
			units = units || data.units;
			// strona bez nowych wiosek = koniec listy (zabezpieczenie przed czytaniem w kółko tej samej strony)
			const fresh = data.villages.filter(v => !seen.has(v.village_id));
			fresh.forEach(v => seen.add(v.village_id));
			villages.push(...fresh);
			if (!data.hasNext || !fresh.length) { break; }
		}
		return { options, units, villages };
	}

	// ---------- Obliczenia ----------

	// Czas zbieractwa (s) dla łupu `haul` – ten sam wzór, którego używa gra (parametry z danych poziomu)
	const duration = (opt, haul) =>
		(Math.pow(haul * haul * 100, opt.duration_exponent) + opt.duration_initial_seconds) * opt.duration_factor;

	// Łup, przy którym zbieractwo trwa dokładnie `seconds` (odwrotność wzoru powyżej)
	const haulForDuration = (opt, seconds) => {
		const base = seconds / opt.duration_factor - opt.duration_initial_seconds;
		return base > 0 ? Math.sqrt(Math.pow(base, 1 / opt.duration_exponent) / 100) : 0;
	};

	// Plan dla jednej wioski: lista oddziałów { optionId, counts, carry, haul, seconds }
	function planVillage(village, data, settings) {
		const cf = village.unit_carry_factor || 1;
		const unitIds = SCAV_UNITS.filter(u => settings.units[u] && data.units[u] && data.units[u].carry > 0);
		const avail = {};
		for (const u of unitIds) {
			avail[u] = Math.max(0, (village.unit_counts_home[u] || 0) - (settings.reserve[u] || 0));
		}
		const carryOf = counts => Object.keys(counts).reduce((t, u) => t + counts[u] * data.units[u].carry * cf, 0);
		const popOf = counts => Object.keys(counts).reduce((t, u) => t + counts[u] * data.units[u].pop, 0);
		const totalCarry = carryOf(avail);
		if (!village.has_rally_point || totalCarry <= 0) { return { squads: [], reason: totalCarry <= 0 ? 'brak wojsk' : 'brak placu' }; }

		// Wolne poziomy: wybrane w panelu, odblokowane i bez trwającego zbieractwa
		let levels = Object.keys(data.options).map(Number).filter(id => {
			const st = village.options[id];
			return settings.levels[id - 1] && st && !st.is_locked && !st.unlock_time && !st.scavenging_squad;
		}).sort((a, b) => data.options[a].loot_factor - data.options[b].loot_factor);
		if (!levels.length) { return { squads: [], reason: 'brak wolnych poziomów' }; }

		while (levels.length) {
			// Równy powrót = równy łup na każdym poziomie, więc udźwig poziomu = łup / współczynnik łupu
			const invSum = levels.reduce((t, id) => t + 1 / data.options[id].loot_factor, 0);
			const equalHaul = totalCarry / invSum;
			const targets = levels.map(id => {
				const opt = data.options[id];
				const haul = settings.mode === 'time'
					? Math.min(equalHaul, haulForDuration(opt, settings.hours * 3600))
					: equalHaul;
				return haul / opt.loot_factor;
			});
			const targetSum = targets.reduce((a, b) => a + b, 0);
			const useAll = targetSum >= totalCarry - 1e-6;

			// Każdy poziom dostaje tę samą mieszankę jednostek w proporcji do swojego udźwigu
			const counts = levels.map(() => ({}));
			for (const u of unitIds) {
				levels.forEach((_, i) => { counts[i][u] = Math.floor(avail[u] * targets[i] / totalCarry); });
				if (useAll) {
					// resztę z zaokrągleń dokładamy tam, gdzie brakuje najwięcej udźwigu
					let left = avail[u] - counts.reduce((t, c) => t + c[u], 0);
					while (left > 0) {
						let best = 0;
						let bestGap = -Infinity;
						levels.forEach((_, i) => {
							const gap = targets[i] - carryOf(counts[i]);
							if (gap > bestGap) { bestGap = gap; best = i; }
						});
						counts[best][u]++;
						left--;
					}
				}
			}

			// Gra przyjmuje oddział od MIN_POP populacji – jeśli któryś poziom nie dobija, odpada najsłabszy poziom
			if (counts.some(c => popOf(c) < MIN_POP)) {
				levels = levels.slice(1);
				continue;
			}

			const squads = levels.map((id, i) => {
				const c = {};
				for (const u of unitIds) { if (counts[i][u] > 0) { c[u] = counts[i][u]; } }
				const carry = carryOf(c);
				const haul = carry * data.options[id].loot_factor;
				return { optionId: id, counts: c, carry, haul, seconds: duration(data.options[id], haul) };
			});
			return { squads, reason: '' };
		}
		return { squads: [], reason: 'za mało wojsk (min. ' + MIN_POP + ' populacji na oddział)' };
	}

	function createPlan(data, settings) {
		if (!SCAV_UNITS.some(u => settings.units[u])) { throw 'Zaznacz co najmniej jedną jednostkę.'; }
		if (!settings.levels.some(Boolean)) { throw 'Zaznacz co najmniej jeden poziom zbieractwa.'; }
		if (settings.mode === 'time' && !(settings.hours > 0)) { throw 'Wpisz czas zbieractwa w godzinach.'; }
		if (settings.mode === 'time') {
			// najkrótsze możliwe zbieractwo (prawie pusty oddział) – krótszego czasu gra nie da
			const shortest = Math.max(...Object.values(data.options).map(opt => duration(opt, 0)));
			if (settings.hours * 3600 <= shortest) { throw 'Zadany czas jest za krótki – minimum to ok. ' + fmtTime(shortest) + '.'; }
		}
		return data.villages.map(v => ({ village: v, ...planVillage(v, data, settings) }));
	}

	// ---------- Panel ----------

	function unitIcon(u) {
		return `<img src="${image_base}unit/unit_${u}.png" style="vertical-align:middle">`;
	}

	function readPanel() {
		const s = JSON.parse(JSON.stringify(DEFAULTS));
		for (const u of SCAV_UNITS) {
			s.units[u] = $(`#${NS}_unit_${u}`).is(':checked');
			const raw = String($(`#${NS}_reserve_${u}`).val() ?? '').trim();
			s.reserve[u] = raw === '' ? 0 : Math.max(0, Math.floor(Number(raw)) || 0);
		}
		s.levels = [1, 2, 3, 4].map(i => $(`#${NS}_level_${i}`).is(':checked'));
		s.mode = $(`input[name=${NS}_mode]:checked`).val() === 'time' ? 'time' : 'equal';
		const hours = Number(String($(`#${NS}_hours`).val() ?? '').replace(',', '.'));
		s.hours = hours > 0 ? hours : DEFAULTS.hours;
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

		const html = `
		<div id="${NS}" class="vis vis_item" style="margin-bottom:10px;padding:8px">
			<h3 style="margin:0 0 6px 0">${NAME} <small>${VERSION}</small></h3>
			<p style="margin:0 0 8px 0">Działa na grupie wybranej na tej stronie (wszystkie strony listy). Każda wioska dostaje własny podział.</p>
			<table class="vis" style="width:100%">
				<tr><th>Jednostka</th><th>Wysyłaj</th><th>Zostaw w wiosce</th></tr>
				${unitRows}
				<tr><th colspan="3">Poziomy i czas</th></tr>
				<tr><td>Poziomy</td><td colspan="2"><div style="white-space:nowrap">${levelBoxes}</div>
					<small>używane są tylko odblokowane i wolne poziomy; oddział musi mieć min. 10 populacji, inaczej pomijany jest najsłabszy poziom</small></td></tr>
				<tr><td>Tryb</td><td colspan="2">
					<label><input type="radio" name="${NS}_mode" value="equal" ${settings.mode !== 'time' ? 'checked' : ''}> <b>Równy powrót</b> – wszystkie dostępne wojska, wszystkie poziomy wracają razem</label><br>
					<label><input type="radio" name="${NS}_mode" value="time" ${settings.mode === 'time' ? 'checked' : ''}> <b>Zadany czas</b> – tylko tyle wojsk, żeby wrócić po</label>
					<input type="text" id="${NS}_hours" value="${settings.hours}" style="width:40px"> h
					<br><small>gdy wojsk jest za mało na zadany czas, wysyłane są wszystkie i wracają wcześniej</small></td></tr>
			</table>
			<div id="${NS}_warn" style="margin-top:6px;color:#c00;font-weight:bold"></div>
			<div style="margin-top:8px">
				<input type="button" class="btn" id="${NS}_calc" value="Oblicz plan">
				<input type="button" class="btn btn-disabled" id="${NS}_send" value="Wyślij partię">
			</div>
			<div id="${NS}_plan" style="margin-top:8px"></div>
		</div>`;
		$('#content_value').prepend(html);

		const update = () => {
			const s = readPanel();
			storageSet('settings', s);
			// ostrzeżenie: zaznaczone jednostki bez rezerwy wyjadą w całości z każdej wioski grupy, także z wiosek atakowanych
			const noReserve = units.filter(u => s.units[u] && !s.reserve[u]).map(u => UNIT_NAMES[u]);
			$('#' + NS + '_warn').html(noReserve.length
				? `Uwaga: bez rezerwy (${noReserve.join(', ')}) – skrypt wyśle wszystkie własne jednostki tego typu z każdej wioski grupy, także z wiosek atakowanych. ` +
				'Wpisz „Zostaw w wiosce” albo wybierz grupę bez atakowanych wiosek.'
				: '');
		};
		$('#' + NS).on('input change', 'input', update);
		update();
	}

	function renderPlan(plan, data) {
		const rows = [];
		let squadsTotal = 0;
		let haulTotal = 0;
		let skipped = 0;
		for (const p of plan) {
			if (!p.squads.length) { skipped++; continue; }
			squadsTotal += p.squads.length;
			const haul = p.squads.reduce((t, s) => t + s.haul, 0);
			haulTotal += haul;
			const back = Math.max(...p.squads.map(s => s.seconds));
			const cells = [1, 2, 3, 4].map(id => {
				const s = p.squads.find(x => x.optionId === id);
				if (!s) { return '<td style="color:#999">–</td>'; }
				return '<td>' + Object.keys(s.counts).map(u => `${unitIcon(u)}${fmt(s.counts[u])}`).join(' ') + '</td>';
			}).join('');
			rows.push(`<tr><td>${esc(p.village.village_name)}</td>${cells}<td>${fmtTime(back)}</td><td>${fmt(haul)}</td></tr>`);
		}
		const header = [1, 2, 3, 4].map(id => `<th>Poziom ${id}</th>`).join('');
		const batches = Math.ceil(plan.filter(p => p.squads.length).length / BATCH_VILLAGES);
		$('#' + NS + '_plan').html(`
			<p>Wiosek z wysyłką: <b>${plan.length - skipped}</b> z ${plan.length}, oddziałów: <b>${squadsTotal}</b>,
			łup razem: <b>${fmt(haulTotal)}</b> surowców. Partii do wysłania: <b>${batches}</b> (tyle kliknięć „Wyślij partię”).</p>
			<div style="max-height:360px;overflow-y:auto;border:1px solid #c1a264">
				<table class="vis" style="width:100%"><tr><th>Wioska</th>${header}<th>Powrót za</th><th>Łup</th></tr>${rows.join('')}</table>
			</div>
			${skipped ? `<small>Pominięte wioski (${skipped}): ${plan.filter(p => !p.squads.length).slice(0, 15).map(p =>
				esc(p.village.village_name.trim()) + ' – ' + p.reason).join('; ')}${skipped > 15 ? '…' : ''}</small>` : ''}`);
	}

	// Jedno zapytanie = jedna partia; ten sam format, którego używa przycisk „Wyślij” gry
	function sendBatch(batch) {
		const squadRequests = [];
		for (const p of batch) {
			for (const s of p.squads) {
				squadRequests.push({
					village_id: p.village.village_id,
					candidate_squad: { unit_counts: s.counts, carry_max: s.carry },
					option_id: s.optionId,
					use_premium: false
				});
			}
		}
		return new Promise((resolve, reject) => {
			TribalWars.post('scavenge_api', { ajaxaction: 'send_squads' }, { squad_requests: squadRequests },
				response => resolve({ response, count: squadRequests.length }),
				() => reject('serwer gry odrzucił zapytanie'));
		});
	}

	// ---------- Start ----------

	try {
		console.log(NAME + ' ' + VERSION + ': start', game_data.screen, game_data.mode);
		if (!(game_data.screen === 'place' && game_data.mode === 'scavenge_mass')) {
			location.href = '/game.php?village=' + game_data.village.id + '&screen=place&mode=scavenge_mass' + sitterParam();
			return;
		}
		// Drugie kliknięcie chowa panel – ale podwójne uruchomienie tuż po otwarciu (np. skrót wykonany dwa razy) jest ignorowane
		if ($('#' + NS).length) {
			if (Date.now() - ($('#' + NS).data('opened') || 0) > 1500) { $('#' + NS).remove(); }
			return;
		}
		if (!$('#content_value').length) { notify(NAME + ': nie znaleziono treści strony – włącz wersję gry na komputer.'); return; }

		const settings = loadSettings();
		renderPanel(settings);
		$('#' + NS).data('opened', Date.now());

		let plan = null;
		let planTime = 0;
		let queue = [];
		let busy = false;
		let sentBatches = 0;

		$('#' + NS + '_calc').on('click', async () => {
			if (busy) { return; }
			busy = true;
			queue = [];
			sentBatches = 0; // nowy plan – numeracja partii od początku
			$('#' + NS + '_send').addClass('btn-disabled').val('Wyślij partię');
			$('#' + NS + '_plan').html('<i>Pobieranie aktualnych wojsk ze wszystkich stron…</i>');
			try {
				const s = readPanel();
				storageSet('settings', s);
				const data = await fetchAll();
				plan = createPlan(data, s);
				planTime = Date.now();
				renderPlan(plan, data);
				const withSquads = plan.filter(p => p.squads.length);
				for (let i = 0; i < withSquads.length; i += BATCH_VILLAGES) { queue.push(withSquads.slice(i, i + BATCH_VILLAGES)); }
				if (queue.length) {
					$('#' + NS + '_send').removeClass('btn-disabled').val(`Wyślij partię 1/${queue.length}`);
				}
			} catch (ex) {
				$('#' + NS + '_plan').html('');
				notify(NAME + ': ' + (typeof ex === 'string' ? ex : 'nie udało się pobrać danych z gry – spróbuj ponownie.'));
			} finally {
				busy = false;
			}
		});

		$('#' + NS + '_send').on('click', async function () {
			if (busy || !queue.length) { return; }
			if (Date.now() - planTime > PLAN_TTL) {
				queue = [];
				$(this).addClass('btn-disabled').val('Wyślij partię');
				notify(NAME + ': plan ma ponad 10 minut – kliknij „Oblicz plan” jeszcze raz.');
				return;
			}
			busy = true;
			$(this).addClass('btn-disabled');
			const total = sentBatches + queue.length;
			const batch = queue.shift();
			try {
				const { response, count } = await sendBatch(batch);
				sentBatches++;
				const r = (response && response.squad_responses) ? response : (response && response.response) || {};
				const results = r.squad_responses || [];
				const failed = results.filter(x => !x.success);
				let msg = `${NAME}: partia ${sentBatches}/${total} – wysłano ${count - failed.length} z ${count} oddziałów.`;
				if (failed.length) {
					const reasons = [...new Set(failed.map(x => x.error).filter(Boolean))];
					msg += `<br>Nie wysłano ${failed.length}` + (reasons.length ? ': ' + reasons.map(esc).join('; ') : '') +
						' (np. wojska zmieniły się od obliczenia planu).';
				}
				if (r.invalid_village_ids && r.invalid_village_ids.length) { msg += `<br>Pominięte wioski: ${r.invalid_village_ids.length}.`; }
				msg += queue.length ? ' Kliknij „Wyślij partię” dla następnej.' : ' To była ostatnia partia – odśwież stronę.';
				notify(msg, failed.length ? 'ErrorMessage' : 'SuccessMessage');
			} catch (ex) {
				queue.unshift(batch); // nie wysłano – partia zostaje do ponownej próby
				notify(NAME + ': ' + (typeof ex === 'string' ? ex : 'błąd wysyłki') + '. Spróbuj ponownie albo przelicz plan.');
			} finally {
				busy = false;
				if (queue.length) {
					$(this).removeClass('btn-disabled').val(`Wyślij partię ${sentBatches + 1}/${sentBatches + queue.length}`);
				} else {
					$(this).val('Wysłano wszystko');
				}
			}
		});
	} catch (ex) {
		// każdy błąd widoczny na ekranie, a nie tylko w konsoli
		notify(NAME + ' ' + VERSION + ': błąd – ' + (ex && ex.message ? ex.message : ex));
		console.error(NAME, ex);
	}
})();
