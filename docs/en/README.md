# Adapter Eufy-Security
## Installation

Of course, first install ioBroker in the usual way.

Follow these steps to install Eufy-ecurity into ioBroker:

1. Select Adapters in the left menu
2. Choose Install from custom URL
![Install from custom url](./img/Install01.png)

3. Select the Custom tab
4. Enter the url to eufy-security: https://github.com/bropat/ioBroker.eufy-security
5. Click Install
![Install eufy-security](./img/Install02.png)

Wait until the adapter has finished installing and continue with configuration.

## Updating
Updating the plugin with the latest release can be done by following the installation manual again. Configuration will be kept safe and the new version will simply take over.

## Configuration

![Configuration screen overview](./img/config01.png)

Coniguration parameter | Description
- | -
Username | Your Eufy account username
Password | Your Eufy account password
Polling intervall (min.) | Every x minutes the data is queried again from the Eufy Cloud
Max camera livestream duration (sec.) | Maximum duration of a live stream in seconds
Time in seconds before event reset | Time in seconds before a motion event, person detected event, etc. is reset

### Two Factor Authentication

The adapter detects automatically if the Eufy account has the 2FA enabled and requests a verification code by mail. The state of the adapter instance will be yellow:

![Adapter instance state yellow](./img/config02.png)

In the ioBroker Logs view you will see the following message:

![ioBroker Logs - Message: Requested verification code for 2FA](./img/config03.png)

Take the verification code from the received mail:

![Mail example screen with verification code](./img/config04.png)

Go to the ioBroker Objects view and navigate to the `eufy-security.0.verify_code` state, enter the received verification code and confirm:

![Example for code verification entering on ioBroker Objects view](./img/config05.png)

The entered verification code will disappear. 
The object tree will be updated and you will see the following:

![Example Object view state eufy-security.0 info.connection with true value](./img/config06.png)

Now go to the ioBroker Instances view and you will see that the status has also changed to green:

![Example instance state after entering the correct verification code](./img/config07.png)
