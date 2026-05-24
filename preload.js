const { ipcRenderer } = require('electron');

window.riotInvoke = (payload) => {
  const request = typeof payload === 'string' ? payload : payload && payload.request;
  const onSuccess = payload && typeof payload.onSuccess === 'function' ? payload.onSuccess : null;
  const onFailure = payload && typeof payload.onFailure === 'function' ? payload.onFailure : null;
  if (typeof request === 'string') {
    ipcRenderer.invoke('riot-invoke', { request })
      .then((result) => {
        if (onSuccess) onSuccess(result);
      })
      .catch((error) => {
        if (onFailure) onFailure(-1, error.message);
      });
  }
  return undefined;
};

window.alert = () => {};
window.confirm = () => false;

window.__leagueElectronDrag = {
  start(screenX, screenY) {
    ipcRenderer.send('league-window-drag-start', { screenX, screenY });
  },
  move(screenX, screenY) {
    ipcRenderer.send('league-window-drag-move', { screenX, screenY });
  },
  end() {
    ipcRenderer.send('league-window-drag-end');
  }
};

window.addEventListener('error', (event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

window.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
