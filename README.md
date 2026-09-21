Zora — A remotely hosted Discord Rich Presence studio

Zora is a custom Discord Rich Presence controller that I built to let me create and control Discord activities from an iPhone/web interface.

Instead of relying on my phone to maintain the Discord connection, Zora uses a remotely hosted Linux worker running Discord's official Social SDK. The iPhone communicates with my Zora backend, which securely communicates with the remote worker, and the worker maintains the Discord Rich Presence independently.

Architecture:

iPhone / Web UI  
↓  
Zora Backend  
↓  
Authenticated API  
↓  
Northflank Linux Worker  
↓  
Discord Social SDK  
↓  
Discord Rich Presence

The project includes a custom activity editor, presets, authentication between the backend and worker, automated deployment, secure environment variables, and a persistent remote worker.

One of the main goals was solving the limitation of trying to maintain Rich Presence directly from an iPhone. By moving the Discord SDK connection to a remote Linux worker, the phone becomes a controller rather than the device responsible for keeping the presence alive.

The final result is a working end-to-end application rather than just a prototype.
