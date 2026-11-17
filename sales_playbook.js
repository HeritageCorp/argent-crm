(function(root) {
  function clean(value, maxLength) {
    return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
  }

  function firstName(prospect) {
    const director = clean(prospect && prospect.dirigeant, 120);
    if (!director || director === 'Dirigeant') return '';
    return director.split(/\s+/)[0];
  }

  function buildCallPitch(prospect = {}) {
    const person = firstName(prospect);
    const greeting = person ? 'Bonjour ' + person : 'Bonjour';
    const company = clean(prospect.nom, 160) || 'votre entreprise';
    const trade = clean(prospect.metier, 120) || 'votre activité';
    const city = clean(prospect.ville, 120);
    const location = city ? ' à ' + city : '';
    return greeting + ', je vous appelle au sujet d’un aperçu de site vitrine pour ' +
      company + ', adapté à votre métier de ' + trade + location +
      '. Si vous le souhaitez, je peux vous le présenter et recueillir votre avis.';
  }

  function buildObjectionMessage(type, prospect = {}) {
    const person = firstName(prospect);
    const greeting = 'Bonjour' + (person ? ' ' + person : '') + ',';
    const company = clean(prospect.nom, 160) || 'votre entreprise';
    const messages = {
      budget: 'Je comprends, le budget doit être clair. Je peux vous détailler le périmètre et les options, puis vous laisser décider sans engagement.',
      time: 'Je comprends que vous soyez occupé. Préférez-vous un rappel à un créneau précis, ou que je clôture la relance ?',
      usefulness: 'C’est légitime. L’aperçu sert à voir concrètement une possibilité pour ' + company +
        '; si cela ne répond pas à un besoin réel, nous en restons là. Aucun résultat commercial n’est garanti.',
      existing_site: 'Très bien. Je ne pars pas du principe qu’il faut remplacer votre site. La maquette peut simplement servir de comparaison, si cela vous intéresse.',
      no_followup: 'Merci pour votre réponse. Je prends note et ne vous relancerai plus à ce sujet.'
    };
    return greeting + ' ' + (messages[type] || messages.no_followup);
  }

  const api = { buildCallPitch, buildObjectionMessage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.KynextPlaybook = api;
})(typeof window !== 'undefined' ? window : globalThis);
