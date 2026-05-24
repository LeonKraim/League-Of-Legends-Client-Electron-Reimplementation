const { ipcRenderer } = require('electron');

window.riotInvoke = (payload) => {
  const request = typeof payload === 'string' ? payload : payload && payload.request;
  if (typeof request === 'string') {
    ipcRenderer.send('riot-invoke', request);
  }
  return undefined;
};
