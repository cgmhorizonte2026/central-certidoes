// Municipal progress is independent of the legacy CAPTCHA retry loop.
(() => {
  window.municipalInteraction = events => {
    const event = events.findLast(e => e.type === 'municipal_state');
    if (!event || event.state === 'finished') return null;
    return {...event,canContinue:['awaiting_manual','awaiting_checkpoint','document_ready'].includes(event.state)};
  };
})();
