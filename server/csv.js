/**
 * Lecteur CSV en flux, pour lire les 150 Mo de la base IRVE sans tout charger en mémoire.
 * Gère les guillemets, les "" et les retours à la ligne dans les champs. Le séparateur (, ou ;)
 * est deviné sur la ligne d'en-tête. Prend un itérable async de chaînes, rend un objet par ligne.
 */
export async function* parseCsv(chunks) {
  let sep = null;
  let header = null;
  let field = '';
  let row = [];
  let inQuotes = false;
  let pendingQuote = false; // guillemet en fin de morceau : on ne sait pas encore s'il est doublé
  let headerBuf = '';

  const emit = function* () {
    if (header === null) {
      header = row.map((h) => h.replace(/^\uFEFF/, '').trim());
    } else if (!(row.length === 1 && row[0] === '')) {
      const obj = {};
      for (let i = 0; i < header.length; i++) obj[header[i]] = row[i] ?? '';
      yield obj;
    }
    row = [];
  };

  for await (const chunk of chunks) {
    let text = chunk;
    if (sep === null) {
      headerBuf += text;
      const nl = headerBuf.indexOf('\n');
      if (nl === -1) continue;
      const first = headerBuf.slice(0, nl);
      sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
      text = headerBuf;
      headerBuf = '';
    }
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (pendingQuote) {
        pendingQuote = false;
        if (ch === '"') {
          field += '"';
          continue;
        }
        inQuotes = false;
      }
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < text.length) {
            if (text[i + 1] === '"') {
              field += '"';
              i++;
            } else inQuotes = false;
          } else pendingQuote = true;
        } else field += ch;
        continue;
      }
      if (ch === '"' && field === '') inQuotes = true;
      else if (ch === sep) {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
        field = '';
        yield* emit();
      } else field += ch;
    }
  }
  if (sep === null && headerBuf) {
    // fichier minuscule, sans retour à la ligne final
    yield* parseCsv([headerBuf + '\n']);
    return;
  }
  if (field !== '' || row.length) {
    row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
    yield* emit();
  }
}

/** Lit la réponse d'un fetch morceau par morceau, en texte UTF-8. */
export async function* streamToText(body) {
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of body) yield decoder.decode(chunk, { stream: true });
  const rest = decoder.decode();
  if (rest) yield rest;
}
