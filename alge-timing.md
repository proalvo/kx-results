# Alge-Timing Timy(3)

This is an experimental feature made in 9/2026. You should test before using it. **Instuctions are not ready yet**, but you might get the software working anyhow.

Requirements:
- You need Alge Timing's Timy3. It might work with older versions also.
- Timy3 is connected to the PC with USB cable or RS232-USC adapter.
  - If the Timy is connected directly to the PC with USB cable, you may <need to install Alge's driver.
  - If the Timy is connected to the PC with RS232-USB adapter, then the Timy is not recognized automatically. You might need some USB Serial driver on windows copmuter. Once you figures aout how the RS232-USB is working,just use the "connect anyway" to connect.
 
 
## Configuration

Setup page have instruction to connect to the Timy.

Connect the Timy with with USB cable or RS232-USB adapter cable. If you use the USB cable and Windows 10/11 you need to install the driver which can be downloaded from Alge-Timing's page. 

With Linux you propably need to use the RS232-USB adapter cable. In this case the Timy is not recognised automatically, but you can connect anyway.

![Connecting to Timy](images/timy-setting-1.png) 

There are additional setting to set thresholds to recognize faulty impulses from the Timy. 

Timy support different methdos to send the time. Different methods are idenfied by the channel. **Note: I have not been able to test different methods**

- TT - total time
- RT - run time
- c0/c1 - Time sends start time and end time separatly.

![Connecting to Timy](images/timy-setting-2.png) 

## How to use

Go to the Page page, and start the Time Trial. Accept valid timestamps.

![Connecting to Timy](images/timy-timing-2.png) 



## Reference documentation

https://alge-timing.com/downloads/userGuides/Timy3-Allgemein-BE.pdf
