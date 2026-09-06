# Alge-Timing Timy(3)

This is experimental feature made in 9/2026- you should test before using it.

Requirements:
- You need Alge Timing's Timy3. It might work with older versions also-
- Timy3 is connected to the PC with USB cable or RS232-USC adapter.
  - If Timy is connected to directly to the PC with USB cable, you need to install Alge's driver.
  - If Timy is connected to the PC with RS232-USB adapter, then the Timy is recognized automatically - just use "connect anyway" to connect.
 
## Reference documentation

https://alge-timing.com/downloads/userGuides/Timy3-Allgemein-BE.pdf
 
## Installation

Software for the Timy is inluced in the ZIP file if you copy kx-server software from the Github.

Installation:

```
cd {your document root}/kx-server/timy-bridge/
npm install
```
You might get warnings when running the install command. However, the software should work anyhow. Follow the insturctios to if you want to mak sure that the softare is latest.

You are ready now. Start to software normally

Windows:
```Windows
cd {your document root}/kx-server
node server.js
```
NOTE! if you are running the software on Linux computer, you must start the software as super user, otherwise the siftware does not have permission to acces the USB/serial port. Use `sudo` start the software.

Linux:
```Linux
cd {your document root}/kx-server
sude node server.js
```


## Configuration

Text coming soon.

## How to use

Text coming soon.
