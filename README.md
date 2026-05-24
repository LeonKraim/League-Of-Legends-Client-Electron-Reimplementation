
# League Client Electron Reimplementation


<img width="800" height="450" alt="ezgif-3e4f63d072339568" src="https://github.com/user-attachments/assets/d32c8063-e18b-49f8-b72c-2d95da9b60e7" />  


    
  A standalone Electron shell that surrounds the League of Legends client. Finds the running process ('LeagueClientUx.exe'), extracts the active remoting credentials ('--app-port', '--remoting-auth-token') and launches a local bridge that delivers frontend resource files from the installed plugin WADs while passing through HTTP and WebSocket requests to the authenticated LCU server. Features.
Ressources are gotten through on-demand extraction of JavaScript/ CSS/ images from assets. wad files through @@lol-archiver/lol-wad-extract
Proxies API calls and WAMP WebSockets connections to the League client.
Auto-launch initializes League if the program isn't running, disables the stock UX window as well as the splash of the Riot Client
Edit `settings. json' to manually enter League/Riot install directories incase autodetect fails


