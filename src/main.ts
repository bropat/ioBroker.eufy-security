/*
 * Created with @iobroker/create-adapter v1.28.0
 */

import * as utils from "@iobroker/adapter-core";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { strict } from "assert";
import * as path from "path";
import * as fs from "fs";
import { Camera, Device, EntrySensor, Keypad, MotionSensor, Devices, Station, Stations, PushMessage, Credentials, DoorbellPushEvent, IndoorPushEvent, CusPushEvent, ServerPushEvent, GuardMode, DeviceType, IndoorCamera, Lock, P2PConnectionType } from "eufy-security-client";
import { getAlpha2Code as getCountryCode } from "i18n-iso-countries"
import { isValid as isValidLanguageCode } from "@cospired/i18n-iso-languages"

import * as EufySecurityAPI from "./lib/eufy-security/eufy-security";
import * as Interface from "./lib/eufy-security/interfaces"
import { CameraStateID, DataLocation, DeviceStateID, DoorbellStateID, EntrySensorStateID, IndoorCameraStateID, KeyPadStateID, LockStateID, MotionSensorStateID, StationStateID } from "./lib/eufy-security/types";
import { generateSerialnumber, generateUDID, getVideoClipLength, handleUpdate, isEmpty, md5, removeLastChar, saveImageStates, setStateChangedAsync, setStateChangedWithTimestamp } from "./lib/eufy-security/utils";
import { PersistentData } from "./lib/eufy-security/interfaces";
import { ioBrokerLogger } from "./lib/eufy-security/log";

// Augment the adapter.config object with the actual types
// TODO: delete this in the next version
declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace ioBroker {
        // eslint-disable-next-line @typescript-eslint/no-empty-interface
        interface AdapterConfig extends Interface.AdapterConfig{
            // Define the shape of your options here (recommended)
            // Or use a catch-all approach
            //[key: string]: any;
        }
    }
}

export class EufySecurity extends utils.Adapter {

    private eufy!: EufySecurityAPI.EufySecurity;
    private refreshEufySecurityTimeout?: NodeJS.Timeout;
    private personDetected: {
        [index: string]: NodeJS.Timeout;
    } = {};
    private motionDetected: {
        [index: string]: NodeJS.Timeout;
    } = {};
    private ringing: {
        [index: string]: NodeJS.Timeout;
    } = {};
    private cryingDetected: {
        [index: string]: NodeJS.Timeout;
    } = {};
    private soundDetected: {
        [index: string]: NodeJS.Timeout;
    } = {};
    private petDetected: {
        [index: string]: NodeJS.Timeout;
    } = {};
    private downloadEvent: {
        [index: string]: NodeJS.Timeout;
    } = {};

    private persistentFile: string;
    private logger!: ioBrokerLogger;
    private persistentData: PersistentData = {
        api_base: "",
        cloud_token: "",
        cloud_token_expiration: 0,
        openudid: "",
        serial_number: "",
        push_credentials: undefined,
        push_persistentIds: [],
        login_hash: "",
        version: ""
    };

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: "eufy-security",
        });
        const data_dir = utils.getAbsoluteInstanceDataDir(this);
        this.persistentFile = path.join(data_dir, "persistent.json");

        if (!fs.existsSync(data_dir))
            fs.mkdirSync(data_dir);

        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        // this.on("objectChange", this.onObjectChange.bind(this));
        // this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {

        this.logger = new ioBrokerLogger(this.log);

        await this.setObjectNotExistsAsync("verify_code", {
            type: "state",
            common: {
                name: "2FA verification code",
                type: "number",
                role: "state",
                read: true,
                write: true,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info", {
            type: "channel",
            common: {
                name: "info"
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.connection", {
            type: "state",
            common: {
                name: "Global connection",
                type: "boolean",
                role: "indicator.connection",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync("info.connection", { val: false, ack: true });
        await this.setObjectNotExistsAsync("info.push_connection", {
            type: "state",
            common: {
                name: "Push notification connection",
                type: "boolean",
                role: "indicator.connection",
                read: true,
                write: false,
            },
            native: {},
        });

        // Remove old states of previous adapter versions
        try {
            const schedule_modes = await this.getStatesAsync("*.schedule_mode");
            if (schedule_modes)
                Object.keys(schedule_modes).forEach(async id => {
                    await this.delObjectAsync(id);
                });
        } catch (error) {
        }
        try {
            const push_notifications = await this.getStatesAsync("push_notification.*");
            if (push_notifications)
                Object.keys(push_notifications).forEach(async id => {
                    await this.delObjectAsync(id);
                });
            await this.delObjectAsync("push_notification");
        } catch (error) {
        }
        try {
            const last_camera_url = await this.getStatesAsync("*.last_camera_url");
            if (last_camera_url)
                Object.keys(last_camera_url).forEach(async id => {
                    await this.delObjectAsync(id);
                });
        } catch (error) {
        }
        try {
            const captured_pic_url = await this.getStatesAsync("*.captured_pic_url");
            if (captured_pic_url)
                Object.keys(captured_pic_url).forEach(async id => {
                    await this.delObjectAsync(id);
                });
        } catch (error) {
        }
        try {
            const person_identified = await this.getStatesAsync("*.person_identified");
            if (person_identified)
                Object.keys(person_identified).forEach(async id => {
                    await this.delObjectAsync(id);
                });
        } catch (error) {
        }
        try {
            const last_captured_pic_url = await this.getStatesAsync("*.last_captured_pic_url");
            if (last_captured_pic_url)
                Object.keys(last_captured_pic_url).forEach(async id => {
                    await this.delObjectAsync(id);
                });
        } catch (error) {
        }
        try {
            const last_captured_pic_html = await this.getStatesAsync("*.last_captured_pic_html");
            if (last_captured_pic_html)
                Object.keys(last_captured_pic_html).forEach(async id => {
                    await this.delObjectAsync(id);
                });
        } catch (error) {
        }
        // End

        // Reset event states if necessary (for example because of an unclean exit)
        await this.initializeEvents(CameraStateID.PERSON_DETECTED);
        await this.initializeEvents(CameraStateID.MOTION_DETECTED);
        await this.initializeEvents(DoorbellStateID.RINGING);
        await this.initializeEvents(IndoorCameraStateID.CRYING_DETECTED);
        await this.initializeEvents(IndoorCameraStateID.SOUND_DETECTED);
        await this.initializeEvents(IndoorCameraStateID.PET_DETECTED);

        try {
            if (fs.statSync(this.persistentFile).isFile()) {
                const fileContent = fs.readFileSync(this.persistentFile, "utf8");
                this.persistentData = JSON.parse(fileContent) as PersistentData;
            }
        } catch (err) {
            this.logger.debug("No stored data from last exit found.");
        }

        //TODO: Temporary Test to be removed!
        /*await this.setObjectNotExistsAsync("test_button", {
            type: "state",
            common: {
                name: "Test button",
                type: "boolean",
                role: "button",
                read: false,
                write: true,
            },
            native: {},
        });
        this.subscribeStates("test_button");
        await this.setObjectNotExistsAsync("test_button2", {
            type: "state",
            common: {
                name: "Test button2",
                type: "boolean",
                role: "button",
                read: false,
                write: true,
            },
            native: {},
        });
        this.subscribeStates("test_button2");*/
        // END

        this.subscribeStates("verify_code");

        const systemConfig = await this.getForeignObjectAsync("system.config");
        let countryCode = undefined;
        let languageCode = undefined;
        if (systemConfig) {
            countryCode = getCountryCode(systemConfig.common.country, "en");
            if (isValidLanguageCode(systemConfig.common.language))
                languageCode = systemConfig.common.language;
        }

        try {
            const adapter_info = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
            if (adapter_info && adapter_info.common && adapter_info.common.version) {
                if (this.persistentData.version !== adapter_info.common.version) {
                    const currentVersion = Number.parseFloat(removeLastChar(adapter_info.common.version, "."));
                    const previousVersion = this.persistentData.version !== "" && this.persistentData.version !== undefined ? Number.parseFloat(removeLastChar(this.persistentData.version, ".")) : 0;
                    this.logger.debug(`Handling of adapter update - currentVersion: ${currentVersion} previousVersion: ${previousVersion}`);

                    if (previousVersion < currentVersion) {
                        await handleUpdate(this, this.logger, previousVersion);
                        this.persistentData.version = adapter_info.common.version;
                        this.writePersistentData();
                    }
                }
            }
        } catch (error) {
            this.logger.error(`Handling of adapter update - Error:`, error);
        }

        this.eufy = new EufySecurityAPI.EufySecurity(this, this.logger, countryCode, languageCode);
        this.eufy.on("stations", (stations) => this.handleStations(stations));
        this.eufy.on("devices", (devices) => this.handleDevices(devices));
        this.eufy.on("push message", (messages) => this.handlePushNotification(messages));
        this.eufy.on("connect", () => this.onConnect());
        this.eufy.on("close", () => this.onClose());
        this.eufy.on("livestream start", (station, device, url) => this.onStartLivestream(station, device, url));
        this.eufy.on("livestream stop", (station, device) => this.onStopLivestream(station, device));
        this.eufy.on("push connect", () => this.onPushConnect());
        this.eufy.on("push close", () => this.onPushClose());

        const api = this.eufy.getApi();
        if (this.persistentData.api_base && this.persistentData.api_base != "") {
            this.logger.debug(`Load previous api_base: ${this.persistentData.api_base}`);
            api.setAPIBase(this.persistentData.api_base);
        }
        if (this.persistentData.login_hash && this.persistentData.login_hash != "") {
            this.logger.debug(`Load previous login_hash: ${this.persistentData.login_hash}`);
            if (md5(`${this.config.username}:${this.config.password}`) != this.persistentData.login_hash) {
                this.logger.info(`Authentication properties changed, invalidate saved cloud token.`);
                this.persistentData.cloud_token = "";
                this.persistentData.cloud_token_expiration = 0;
                this.persistentData.api_base = "";
            }
        } else {
            this.persistentData.cloud_token = "";
            this.persistentData.cloud_token_expiration = 0;
        }
        if (this.persistentData.cloud_token && this.persistentData.cloud_token != "") {
            this.logger.debug(`Load previous token: ${this.persistentData.cloud_token} token_expiration: ${this.persistentData.cloud_token_expiration}`);
            api.setToken(this.persistentData.cloud_token);
            api.setTokenExpiration(new Date(this.persistentData.cloud_token_expiration));
        }
        if (!this.persistentData.openudid || this.persistentData.openudid == "") {
            this.persistentData.openudid = generateUDID();
            this.logger.debug(`Generated new openudid: ${this.persistentData.openudid}`);

        }
        api.setOpenUDID(this.persistentData.openudid);
        if (!this.persistentData.serial_number || this.persistentData.serial_number == "") {
            this.persistentData.serial_number = generateSerialnumber(12);
            this.logger.debug(`Generated new serial_number: ${this.persistentData.serial_number}`);
        }
        api.setSerialNumber(this.persistentData.serial_number);

        await this.eufy.logon();
    }

    public writePersistentData(): void {
        this.persistentData.login_hash = md5(`${this.config.username}:${this.config.password}`);
        try {
            fs.writeFileSync(this.persistentFile, JSON.stringify(this.persistentData));
        } catch (error) {
            this.logger.error(`writePersistentData() - Error: ${error}`);
        }
    }

    public async refreshData(adapter: EufySecurity): Promise<void> {
        this.logger.debug(`PollingInterval: ${adapter.config.pollingInterval}`);
        if (adapter.eufy) {
            this.logger.info("Refresh data from cloud and schedule next refresh.");
            await adapter.eufy.refreshData();
            adapter.refreshEufySecurityTimeout = setTimeout(() => { this.refreshData(adapter); }, adapter.config.pollingInterval * 60 * 1000);
        }
    }

    private async initializeEvents(state: string): Promise<void> {
        const states = await this.getStatesAsync(`*.${state}`);
        if (states) {
            for (const id of Object.keys(states)) {
                const state = states[id];
                if (!!state && state.val === true) {
                    await this.setStateAsync(id, { val: false, ack: true });
                }
            }
        }
    }

    private async clearEvents(events: {
        [index: string]: NodeJS.Timeout;
    }, state: string | undefined = undefined): Promise<void> {
        for (const serialnr of Object.keys(events)) {
            clearTimeout(events[serialnr]);
            try {
                if (state !== undefined) {
                    const states = await this.getStatesAsync(`*.${serialnr}.${state}`);
                    if (states) {
                        for (const id of Object.keys(states)) {
                            await this.setStateAsync(id, { val: false, ack: true });
                        }
                    }
                }
            } catch (error) {
                this.logger.error(`Device ${serialnr} - Error:`, error);
            }
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    private async onUnload(callback: () => void): Promise<void> {
        try {

            if (this.refreshEufySecurityTimeout)
                clearTimeout(this.refreshEufySecurityTimeout);

            await this.clearEvents(this.personDetected, CameraStateID.PERSON_DETECTED);
            await this.clearEvents(this.motionDetected, CameraStateID.MOTION_DETECTED);
            await this.clearEvents(this.ringing, DoorbellStateID.RINGING);
            await this.clearEvents(this.cryingDetected, IndoorCameraStateID.CRYING_DETECTED);
            await this.clearEvents(this.soundDetected, IndoorCameraStateID.SOUND_DETECTED);
            await this.clearEvents(this.petDetected, IndoorCameraStateID.PET_DETECTED);
            await this.clearEvents(this.downloadEvent);

            if (this.eufy)
                this.setPushPersistentIds(this.eufy.getPushPersistentIds());

            this.writePersistentData();

            if (this.eufy)
                this.eufy.close();

            callback();
        } catch (e) {
            callback();
        }
    }

    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  */
    // private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
    //     if (obj) {
    //         // The object was changed
    //         this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    //     } else {
    //         // The object was deleted
    //         this.log.info(`object ${id} deleted`);
    //     }
    // }

    /**
     * Is called if a subscribed state changes
     */
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (state) {

            // don't do anything if the state is acked
            if (!id || state.ack) {
                this.logger.debug(`state ${id} changed: ${state.val} (ack = ${state.ack}) was already acknowledged, ignore it...`);
                return;
            }
            this.logger.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

            const values = id.split(".");
            const station_sn = values[2];
            const device_type = values[3];

            if (station_sn == "verify_code") {
                if (this.eufy) {
                    this.logger.info(`Verification code received, send it. (verify_code: ${state.val})`);
                    this.eufy.logon(state.val as string);
                    await this.delStateAsync(id);
                }
            } else if (station_sn == "test_button") {
                //TODO: Test to remove!
                this.logger.debug("TEST button pressed");
                if (this.eufy) {
                    //await this.eufy.getStation("T8010P23201721F8").rebootHUB();
                    //await this.eufy.getStation("T8010P23201721F8").setStatusLed(this.eufy.getDevice("T8114P022022261F"), true);
                    //await this.eufy.getStation("T8010P23201721F8").startLivestream(this.eufy.getDevice("T8114P022022261F"));

                    //await this.eufy.getStation("T8010P23201721F8").startLivestream(this.eufy.getDevice("T8114P0220223A5A"));
                    //await this.eufy.getStation("T8010P23201721F8").startDownload("/media/mmcblk0p1/Camera00/20201231171631.dat");

                    const device = this.eufy.getDevice("T8114P0220223A5A");
                    await this.eufy.getStation("T8010P23201721F8").cancelDownload(device!);

                    //const device = this.eufy.getDevice("T8410P2021100D6C");
                    //await this.eufy.getStation("T8410P2021100D6C").setPanAndTilt(device!, 4, 2 /* Right */);

                    //await this.eufy.getApi().sendVerifyCode(VerfyCodeTypes.TYPE_PUSH);
                    //await this.eufy.getStation("T8010P23201721F8").getCameraInfo();
                    //await this.eufy.getStation("T8010P23201721F8").setGuardMode(2);
                    //await this.eufy.getStation("T8010P23201721F8").getStorageInfo();
                }
            } else if (station_sn == "test_button2") {
                //TODO: Test to remove!
                this.logger.debug("TEST button2 pressed");
                if (this.eufy) {
                    try {
                        const device = this.eufy.getDevice("T8114P0220223A5A");
                        if (device)
                            this.downloadEventVideo(device, new Date().getTime() - 12312, "/media/mmcblk0p1/Camera00/20210213171152.dat", 92);
                        //await this.eufy.getStation("T8010P23201721F8").startDownload(`/media/mmcblk0p1/Camera00/${20201008191909}.dat`, cipher.private_key);
                    } catch (error) {
                        this.logger.error(error);
                    }
                    //await this.eufy.getStation("T8010P23201721F8").startDownload("/media/mmcblk0p1/Camera01/20210111071357.dat");
                    //await this.eufy.getStation("T8010P23201721F8").setStatusLed(this.eufy.getDevice("T8114P022022261F"), false);
                    //await this.eufy.getStation("T8010P23201721F8").stopLivestream(this.eufy.getDevice("T8114P022022261F"));
                    //await this.eufy.getStation("T8010P23201721F8").stopLivestream(this.eufy.getDevice("T8114P0220223A5A"));
                }
            } else if (device_type == "cameras") {
                try {
                    const device_sn = values[4];
                    const device_state_name = values[5];
                    const station = this.eufy.getStation(station_sn);
                    const device = this.eufy.getDevice(device_sn);

                    if (this.eufy) {
                        switch(device_state_name) {
                            case CameraStateID.START_STREAM:
                                this.eufy.startLivestream(device_sn);
                                break;

                            case CameraStateID.STOP_STREAM:
                                this.eufy.stopLivestream(device_sn);
                                break;

                            case CameraStateID.LED_STATUS:
                                if (device && state.val !== null)
                                    station.setStatusLed(device, state.val as boolean);
                                break;

                            case CameraStateID.ENABLED:
                                if (device && state.val !== null)
                                    station.enableDevice(device, state.val as boolean);
                                break;

                            case CameraStateID.ANTITHEFT_DETECTION:
                                if (device && state.val !== null)
                                    station.setAntiTheftDetection(device, state.val as boolean);
                                break;

                            case CameraStateID.MOTION_DETECTION:
                                if (device && state.val !== null)
                                    station.setMotionDetection(device, state.val as boolean);
                                break;

                            case CameraStateID.RTSP_STREAM:
                                if (device && state.val !== null) {
                                    const value = state.val as boolean;
                                    station.setRTSPStream(device, value);

                                    if (!value) {
                                        await this.delStateAsync(device.getStateID(CameraStateID.RTSP_STREAM_URL));
                                    }
                                }
                                break;

                            case CameraStateID.AUTO_NIGHTVISION:
                                if (device && state.val !== null)
                                    station.setAutoNightVision(device, state.val as boolean);
                                break;

                            case CameraStateID.WATERMARK:
                                if (device && state.val !== null)
                                    station.setWatermark(device, state.val as number);
                                break;

                            case IndoorCameraStateID.PET_DETECTION:
                                if (device && state.val !== null)
                                    station.setPetDetection(device, state.val as boolean);
                                break;

                            case IndoorCameraStateID.SOUND_DETECTION:
                                if (device && state.val !== null)
                                    station.setSoundDetection(device, state.val as boolean);
                                break;
                        }
                    }
                } catch (error) {
                    this.logger.error(`cameras - Error:`, error);
                }
            } else if (device_type == "station") {
                try {
                    const station_state_name = values[4];
                    if (this.eufy) {
                        const station = this.eufy.getStation(station_sn);
                        switch(station_state_name) {
                            case StationStateID.GUARD_MODE:
                                await station.setGuardMode(<GuardMode>state.val);
                                break;
                            case StationStateID.REBOOT:
                                await station.rebootHUB();
                                break;
                        }
                    }
                } catch (error) {
                    this.logger.error(`station - Error:`, error);
                }
            } else if (device_type == "locks") {
                try {
                    const device_sn = values[4];
                    const device_state_name = values[5];
                    const station = this.eufy.getStation(station_sn);
                    const device = this.eufy.getDevice(device_sn);

                    if (this.eufy) {
                        switch(device_state_name) {
                            case LockStateID.LOCK:
                                if (device && state.val !== null)
                                    station.lockDevice(device, state.val as boolean)
                                break;
                        }
                    }
                } catch (error) {
                    this.logger.error(`locks - Error:`, error);
                }
            }
        } else {
            // The state was deleted
            this.logger.debug(`state ${id} deleted`);
        }
    }

    // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.message" property to be set to true in io-package.json
    //  */
    // private onMessage(obj: ioBroker.Message): void {
    //     if (typeof obj === "object" && obj.message) {
    //         if (obj.command === "send") {
    //             // e.g. send email or pushover or whatever
    //             this.log.info("send command");

    //             // Send response in callback if required
    //             if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
    //         }
    //     }
    // }

    private async handleDevices(devices: Devices): Promise<void> {
        this.logger.debug(`count: ${Object.keys(devices).length}`);

        Object.values(devices).forEach(async device => {

            await this.setObjectNotExistsAsync(device.getStateID("", 0), {
                type: "channel",
                common: {
                    name: device.getStateChannel()
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(device.getStateID("", 1), {
                type: "device",
                common: {
                    name: device.getName()
                },
                native: {},
            });

            // Name
            await this.setObjectNotExistsAsync(device.getStateID(DeviceStateID.NAME), {
                type: "state",
                common: {
                    name: "Name",
                    type: "string",
                    role: "info.name",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await setStateChangedAsync(this, device.getStateID(DeviceStateID.NAME), device.getName());

            // Model
            await this.setObjectNotExistsAsync(device.getStateID(DeviceStateID.MODEL), {
                type: "state",
                common: {
                    name: "Model",
                    type: "string",
                    role: "text",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await setStateChangedAsync(this, device.getStateID(DeviceStateID.MODEL), device.getModel());

            // Serial
            await this.setObjectNotExistsAsync(device.getStateID(DeviceStateID.SERIAL_NUMBER), {
                type: "state",
                common: {
                    name: "Serial number",
                    type: "string",
                    role: "text",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await setStateChangedAsync(this, device.getStateID(DeviceStateID.SERIAL_NUMBER), device.getSerial());

            // Software version
            await this.setObjectNotExistsAsync(device.getStateID(DeviceStateID.SOFTWARE_VERSION), {
                type: "state",
                common: {
                    name: "Software version",
                    type: "string",
                    role: "text",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await setStateChangedAsync(this, device.getStateID(DeviceStateID.SOFTWARE_VERSION), device.getSoftwareVersion());

            // Hardware version
            await this.setObjectNotExistsAsync(device.getStateID(DeviceStateID.HARDWARE_VERSION), {
                type: "state",
                common: {
                    name: "Hardware version",
                    type: "string",
                    role: "text",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await setStateChangedAsync(this, device.getStateID(DeviceStateID.HARDWARE_VERSION), device.getHardwareVersion());

            if (device.isCamera()) {

                const camera = device as Camera;

                if (camera.isCamera2Product() || camera.isBatteryDoorbell() || camera.isBatteryDoorbell2()) {
                    // State
                    await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.STATE), {
                        type: "state",
                        common: {
                            name: "State",
                            type: "number",
                            role: "info.status",
                            read: true,
                            write: false,
                            states: {
                                0: "OFFLINE",
                                1: "ONLINE",
                                2: "MANUALLY_DISABLED",
                                3: "OFFLINE_LOWBAT",
                                4: "REMOVE_AND_READD",
                                5: "RESET_AND_READD"
                            }
                        },
                        native: {},
                    });
                    const state = camera.getState();
                    if (state !== undefined)
                        await setStateChangedWithTimestamp(this, camera.getStateID(CameraStateID.STATE), state.value, state.timestamp);
                }

                // Mac address
                await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.MAC_ADDRESS), {
                    type: "state",
                    common: {
                        name: "MAC Address",
                        type: "string",
                        role: "info.mac",
                        read: true,
                        write: false,
                    },
                    native: {},
                });
                await setStateChangedAsync(this, camera.getStateID(CameraStateID.MAC_ADDRESS), camera.getMACAddress());

                // Last event picture
                const last_camera_url = camera.getLastCameraImageURL();
                if (last_camera_url !== undefined)
                    await saveImageStates(this, last_camera_url.value as string, last_camera_url.timestamp, camera.getStationSerial(), camera.getSerial(), DataLocation.LAST_EVENT, camera.getStateID(CameraStateID.LAST_EVENT_PICTURE_URL),camera.getStateID(CameraStateID.LAST_EVENT_PICTURE_HTML), "Last event picture").catch(() => {
                        this.logger.error(`State LAST_EVENT_PICTURE_URL of device ${camera.getSerial()} - saveImageStates(): url ${camera.getLastCameraImageURL()}`);
                    });

                // Last event video URL
                await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.LAST_EVENT_VIDEO_URL), {
                    type: "state",
                    common: {
                        name: "Last captured video URL",
                        type: "string",
                        role: "url",
                        read: true,
                        write: false,
                        def: ""
                    },
                    native: {},
                });

                // Start Stream
                await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.START_STREAM), {
                    type: "state",
                    common: {
                        name: "Start stream",
                        type: "boolean",
                        role: "button.start",
                        read: false,
                        write: true,
                    },
                    native: {},
                });
                // Stop Stream
                await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.STOP_STREAM), {
                    type: "state",
                    common: {
                        name: "Stop stream",
                        type: "boolean",
                        role: "button.stop",
                        read: false,
                        write: true,
                    },
                    native: {},
                });

                // Livestream URL
                await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.LIVESTREAM), {
                    type: "state",
                    common: {
                        name: "Livestream URL",
                        type: "string",
                        role: "url",
                        read: true,
                        write: false,
                    },
                    native: {},
                });

                // Last livestream video URL
                await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.LAST_LIVESTREAM_VIDEO_URL), {
                    type: "state",
                    common: {
                        name: "Last livestream video URL",
                        type: "string",
                        role: "url",
                        read: true,
                        write: false,
                    },
                    native: {},
                });

                // Last livestream picture URL
                await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.LAST_LIVESTREAM_PIC_URL), {
                    type: "state",
                    common: {
                        name: "Last livestream picture URL",
                        type: "string",
                        role: "url",
                        read: true,
                        write: false,
                    },
                    native: {},
                });

                // Last livestream picture HTML
                await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.LAST_LIVESTREAM_PIC_HTML), {
                    type: "state",
                    common: {
                        name: "Last livestream picture HTML image",
                        type: "string",
                        role: "html",
                        read: true,
                        write: false,
                    },
                    native: {},
                });

                // Device enabled
                await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.ENABLED), {
                    type: "state",
                    common: {
                        name: "Device enabled",
                        type: "boolean",
                        role: "switch.enable",
                        read: true,
                        write: true,
                    },
                    native: {},
                });
                const enabled = camera.isEnabled();
                if (enabled !== undefined)
                    await setStateChangedWithTimestamp(this, camera.getStateID(CameraStateID.ENABLED), enabled.value, enabled.timestamp);

                // Watermark
                let watermark_state: Record<string, string> = {
                    0: "OFF",
                    1: "TIMESTAMP",
                    2: "TIMESTAMP_AND_LOGO"
                };
                if (camera.isWiredDoorbell() || camera.isSoloCameras()) {
                    watermark_state = {
                        0: "OFF",
                        1: "TIMESTAMP"
                    };
                } else if (camera.isBatteryDoorbell() || camera.isBatteryDoorbell2() || camera.getDeviceType() === DeviceType.CAMERA || camera.getDeviceType() === DeviceType.CAMERA_E) {
                    watermark_state = {
                        2: "ON",
                        1: "OFF"
                    };
                } else if (camera.isIndoorCamera() || camera.isFloodLight()) {
                    watermark_state = {
                        0: "TIMESTAMP",
                        1: "TIMESTAMP_AND_LOGO",
                        2: "OFF"
                    };
                }
                await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.WATERMARK), {
                    type: "state",
                    common: {
                        name: "Watermark",
                        type: "number",
                        role: "state",
                        read: true,
                        write: true,
                        states: watermark_state
                    },
                    native: {},
                });
                const watermark = camera.getWatermark();
                if (watermark !== undefined)
                    await setStateChangedWithTimestamp(this, camera.getStateID(CameraStateID.WATERMARK), watermark.value, watermark.timestamp);

                if (camera.isCamera2Product()) {
                    // Antitheft detection
                    await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.ANTITHEFT_DETECTION), {
                        type: "state",
                        common: {
                            name: "Antitheft detection",
                            type: "boolean",
                            role: "switch.enable",
                            read: true,
                            write: true
                        },
                        native: {},
                    });
                    const eas_switch = camera.isAntiTheftDetectionEnabled();
                    if (eas_switch !== undefined)
                        await setStateChangedWithTimestamp(this, camera.getStateID(CameraStateID.ANTITHEFT_DETECTION), eas_switch.value, eas_switch.timestamp);
                }

                // Auto Nightvision
                await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.AUTO_NIGHTVISION), {
                    type: "state",
                    common: {
                        name: "Auto nightvision",
                        type: "boolean",
                        role: "switch.enable",
                        read: true,
                        write: true
                    },
                    native: {},
                });
                const ircut_switch = camera.isAutoNightVisionEnabled();
                if (ircut_switch !== undefined)
                    await setStateChangedWithTimestamp(this, camera.getStateID(CameraStateID.AUTO_NIGHTVISION), ircut_switch.value , ircut_switch.timestamp);

                // Motion detection
                await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.MOTION_DETECTION), {
                    type: "state",
                    common: {
                        name: "Motion detection",
                        type: "boolean",
                        role: "switch.enable",
                        read: true,
                        write: true
                    },
                    native: {},
                });
                const pir_switch = camera.isMotionDetectionEnabled();
                if (pir_switch !== undefined)
                    await setStateChangedWithTimestamp(this, camera.getStateID(CameraStateID.MOTION_DETECTION), pir_switch.value, pir_switch.timestamp);

                if (camera.isCamera2Product() || camera.isIndoorCamera() || camera.isSoloCameras()) {
                    // RTSP Stream
                    await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.RTSP_STREAM), {
                        type: "state",
                        common: {
                            name: "RTSP stream enabled",
                            type: "boolean",
                            role: "switch.enable",
                            read: true,
                            write: true
                        },
                        native: {},
                    });
                    const nas_switch = camera.isRTSPStreamEnabled();
                    if (nas_switch !== undefined)
                        await setStateChangedWithTimestamp(this, camera.getStateID(CameraStateID.RTSP_STREAM), nas_switch.value, nas_switch.timestamp);

                    // RTSP Stream URL
                    await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.RTSP_STREAM_URL), {
                        type: "state",
                        common: {
                            name: "RTSP stream URL",
                            type: "string",
                            role: "url",
                            read: true,
                            write: false
                        },
                        native: {},
                    });
                }

                if (camera.isCamera2Product() || camera.isIndoorCamera() || camera.isSoloCameras() || camera.isFloodLight() || camera.isBatteryDoorbell2() || camera.isBatteryDoorbell() || camera.isWiredDoorbell()) {
                    // LED Status
                    await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.LED_STATUS), {
                        type: "state",
                        common: {
                            name: "LED status",
                            type: "boolean",
                            role: "switch.enable",
                            read: true,
                            write: true
                        },
                        native: {},
                    });
                    const led_switch = camera.isLedEnabled();
                    if (led_switch !== undefined)
                        await setStateChangedWithTimestamp(this, camera.getStateID(CameraStateID.LED_STATUS), led_switch.value, led_switch.timestamp);
                }

                // Battery
                if (camera.hasBattery()) {
                    await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.BATTERY), {
                        type: "state",
                        common: {
                            name: "Battery",
                            type: "number",
                            role: "value.battery",
                            unit: "%",
                            min: 0,
                            max: 100,
                            read: true,
                            write: false,
                        },
                        native: {},
                    });
                    const battery = camera.getBatteryValue();
                    if (battery !== undefined)
                        await setStateChangedWithTimestamp(this, camera.getStateID(CameraStateID.BATTERY), battery.value, battery.timestamp);

                    await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.BATTERY_TEMPERATURE), {
                        type: "state",
                        common: {
                            name: "Battery temperature",
                            type: "number",
                            role: "value.temperature",
                            unit: "°C",
                            read: true,
                            write: false,
                        },
                        native: {},
                    });
                    const battery_temp = camera.getBatteryTemperature();
                    if (battery_temp !== undefined)
                        await setStateChangedWithTimestamp(this, camera.getStateID(CameraStateID.BATTERY_TEMPERATURE), battery_temp.value, battery_temp.timestamp);

                    // Last Charge Used Days
                    await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.LAST_CHARGE_USED_DAYS), {
                        type: "state",
                        common: {
                            name: "Used days since last charge",
                            type: "number",
                            role: "value",
                            read: true,
                            write: false,
                        },
                        native: {},
                    });
                    await setStateChangedAsync(this, camera.getStateID(CameraStateID.LAST_CHARGE_USED_DAYS), camera.getLastChargingDays());

                    // Last Charge Total Events
                    await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.LAST_CHARGE_TOTAL_EVENTS), {
                        type: "state",
                        common: {
                            name: "Total events since last charge",
                            type: "number",
                            role: "value",
                            read: true,
                            write: false,
                        },
                        native: {},
                    });
                    await setStateChangedAsync(this, camera.getStateID(CameraStateID.LAST_CHARGE_TOTAL_EVENTS), camera.getLastChargingTotalEvents());

                    // Last Charge Saved Events
                    await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.LAST_CHARGE_SAVED_EVENTS), {
                        type: "state",
                        common: {
                            name: "Saved/Recorded events since last charge",
                            type: "number",
                            role: "value",
                            read: true,
                            write: false,
                        },
                        native: {},
                    });
                    await setStateChangedAsync(this, camera.getStateID(CameraStateID.LAST_CHARGE_SAVED_EVENTS), camera.getLastChargingRecordedEvents());

                    // Last Charge Filtered Events
                    await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.LAST_CHARGE_FILTERED_EVENTS), {
                        type: "state",
                        common: {
                            name: "Filtered false events since last charge",
                            type: "number",
                            role: "value",
                            read: true,
                            write: false,
                        },
                        native: {},
                    });
                    await setStateChangedAsync(this, camera.getStateID(CameraStateID.LAST_CHARGE_FILTERED_EVENTS), camera.getLastChargingFalseEvents());
                }

                if (camera.isCamera2Product() || camera.isBatteryDoorbell() || camera.isBatteryDoorbell2()) {
                    // Wifi RSSI
                    await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.WIFI_RSSI), {
                        type: "state",
                        common: {
                            name: "Wifi RSSI",
                            type: "number",
                            role: "value",
                            read: true,
                            write: false,
                        },
                        native: {},
                    });
                    const wifi_rssi = camera.getWifiRssi();
                    if (wifi_rssi !== undefined)
                        await setStateChangedWithTimestamp(this, camera.getStateID(CameraStateID.WIFI_RSSI), wifi_rssi.value, wifi_rssi.timestamp);
                }

                // Motion detected
                await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.MOTION_DETECTED), {
                    type: "state",
                    common: {
                        name: "Motion detected",
                        type: "boolean",
                        role: "sensor.motion",
                        read: true,
                        write: false,
                        def: false
                    },
                    native: {},
                });

                // Person detected
                await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.PERSON_DETECTED), {
                    type: "state",
                    common: {
                        name: "Person detected",
                        type: "boolean",
                        role: "sensor.motion",
                        read: true,
                        write: false,
                        def: false
                    },
                    native: {},
                });

                // Person identified
                await this.setObjectNotExistsAsync(camera.getStateID(CameraStateID.LAST_PERSON_IDENTIFIED), {
                    type: "state",
                    common: {
                        name: "Last person identified",
                        type: "string",
                        role: "text",
                        read: true,
                        write: false,
                        def: ""
                    },
                    native: {},
                });

                if (camera.isDoorbell()) {
                    // Ring event
                    await this.setObjectNotExistsAsync(camera.getStateID(DoorbellStateID.RINGING), {
                        type: "state",
                        common: {
                            name: "Ringing",
                            type: "boolean",
                            role: "sensor",
                            read: true,
                            write: false,
                            def: false
                        },
                        native: {},
                    });
                } else if (camera.isIndoorCamera()) {
                    const indoor = device as IndoorCamera;

                    // Sound detection
                    await this.setObjectNotExistsAsync(camera.getStateID(IndoorCameraStateID.SOUND_DETECTION), {
                        type: "state",
                        common: {
                            name: "Sound detection",
                            type: "boolean",
                            role: "switch.enable",
                            read: true,
                            write: true
                        },
                        native: {},
                    });
                    const sound_detection = indoor.isSoundDetectionEnabled();
                    if (sound_detection !== undefined)
                        await setStateChangedWithTimestamp(this, camera.getStateID(IndoorCameraStateID.SOUND_DETECTION), sound_detection.value, sound_detection.timestamp);

                    // Pet detection
                    await this.setObjectNotExistsAsync(camera.getStateID(IndoorCameraStateID.PET_DETECTION), {
                        type: "state",
                        common: {
                            name: "Pet detection",
                            type: "boolean",
                            role: "switch.enable",
                            read: true,
                            write: true
                        },
                        native: {},
                    });
                    const pet_detection = indoor.isPetDetectionEnabled();
                    if (pet_detection !== undefined)
                        await setStateChangedWithTimestamp(this, camera.getStateID(IndoorCameraStateID.PET_DETECTION), pet_detection.value, pet_detection.timestamp);

                    // Crying detected event
                    await this.setObjectNotExistsAsync(camera.getStateID(IndoorCameraStateID.CRYING_DETECTED), {
                        type: "state",
                        common: {
                            name: "Crying detected",
                            type: "boolean",
                            role: "sensor.noise",
                            read: true,
                            write: false,
                            def: false
                        },
                        native: {},
                    });

                    // Sound detected event
                    await this.setObjectNotExistsAsync(camera.getStateID(IndoorCameraStateID.SOUND_DETECTED), {
                        type: "state",
                        common: {
                            name: "Sound detected",
                            type: "boolean",
                            role: "sensor.noise",
                            read: true,
                            write: false,
                            def: false
                        },
                        native: {},
                    });

                    // Pet detected event
                    await this.setObjectNotExistsAsync(camera.getStateID(IndoorCameraStateID.PET_DETECTED), {
                        type: "state",
                        common: {
                            name: "Pet detected",
                            type: "boolean",
                            role: "sensor",
                            read: true,
                            write: false,
                            def: false
                        },
                        native: {},
                    });
                }
            } else if (device.isEntrySensor()) {
                const sensor = device as EntrySensor;

                // State
                await this.setObjectNotExistsAsync(sensor.getStateID(EntrySensorStateID.STATE), {
                    type: "state",
                    common: {
                        name: "State",
                        type: "number",
                        role: "info.status",
                        read: true,
                        write: false,
                        states: {
                            0: "OFFLINE",
                            1: "ONLINE",
                            2: "MANUALLY_DISABLED",
                            3: "OFFLINE_LOWBAT",
                            4: "REMOVE_AND_READD",
                            5: "RESET_AND_READD"
                        }
                    },
                    native: {},
                });
                const status = sensor.getState();
                if (status !== undefined)
                    await setStateChangedWithTimestamp(this, sensor.getStateID(EntrySensorStateID.STATE), status.value, status.timestamp);

                // Sensor Open
                await this.setObjectNotExistsAsync(sensor.getStateID(EntrySensorStateID.SENSOR_OPEN), {
                    type: "state",
                    common: {
                        name: "Sensor open",
                        type: "boolean",
                        role: "sensor",
                        read: true,
                        write: false,
                    },
                    native: {},
                });
                const sensor_status = sensor.isSensorOpen();
                if (sensor_status !== undefined)
                    await setStateChangedWithTimestamp(this, sensor.getStateID(EntrySensorStateID.SENSOR_OPEN), sensor_status.value, sensor_status.timestamp);

                // Low Battery
                await this.setObjectNotExistsAsync(sensor.getStateID(EntrySensorStateID.LOW_BATTERY), {
                    type: "state",
                    common: {
                        name: "Low Battery",
                        type: "boolean",
                        role: "indicator.lowbat",
                        read: true,
                        write: false,
                    },
                    native: {},
                });
                const battery_low = sensor.isBatteryLow();
                if (battery_low !== undefined)
                    await setStateChangedWithTimestamp(this, sensor.getStateID(EntrySensorStateID.LOW_BATTERY), battery_low.value, battery_low.timestamp);

                // Sensor change time
                await this.setObjectNotExistsAsync(sensor.getStateID(EntrySensorStateID.SENSOR_CHANGE_TIME), {
                    type: "state",
                    common: {
                        name: "Sensor change time",
                        type: "number",
                        role: "value",
                        read: true,
                        write: false,
                    },
                    native: {},
                });
                const change_time = sensor.getSensorChangeTime();
                if (change_time !== undefined)
                    await setStateChangedWithTimestamp(this, sensor.getStateID(EntrySensorStateID.SENSOR_CHANGE_TIME), change_time.value, change_time.timestamp);

            } else if (device.isMotionSensor()) {
                const sensor = device as MotionSensor;

                // State
                await this.setObjectNotExistsAsync(sensor.getStateID(MotionSensorStateID.STATE), {
                    type: "state",
                    common: {
                        name: "State",
                        type: "number",
                        role: "info.status",
                        read: true,
                        write: false,
                        states: {
                            0: "OFFLINE",
                            1: "ONLINE",
                            2: "MANUALLY_DISABLED",
                            3: "OFFLINE_LOWBAT",
                            4: "REMOVE_AND_READD",
                            5: "RESET_AND_READD"
                        }
                    },
                    native: {},
                });
                const status = sensor.getState();
                if (status !== undefined)
                    await setStateChangedWithTimestamp(this, sensor.getStateID(MotionSensorStateID.STATE), status.value, status.timestamp);

                // Low Battery
                await this.setObjectNotExistsAsync(sensor.getStateID(MotionSensorStateID.LOW_BATTERY), {
                    type: "state",
                    common: {
                        name: "Low Battery",
                        type: "boolean",
                        role: "indicator.lowbat",
                        read: true,
                        write: false,
                    },
                    native: {},
                });
                const low_battery = sensor.isBatteryLow();
                if (low_battery !== undefined)
                    await setStateChangedWithTimestamp(this, sensor.getStateID(MotionSensorStateID.LOW_BATTERY), low_battery.value, low_battery.timestamp);

                // Motion detected
                await this.setObjectNotExistsAsync(sensor.getStateID(MotionSensorStateID.MOTION_DETECTED), {
                    type: "state",
                    common: {
                        name: "Motion detected",
                        type: "boolean",
                        role: "sensor.motion",
                        read: true,
                        write: false,
                        def: false
                    },
                    native: {},
                });
            } else if (device.isKeyPad()) {
                const keypad = device as Keypad;

                // State
                await this.setObjectNotExistsAsync(keypad.getStateID(KeyPadStateID.STATE), {
                    type: "state",
                    common: {
                        name: "State",
                        type: "number",
                        role: "info.status",
                        read: true,
                        write: false,
                        states: {
                            0: "OFFLINE",
                            1: "ONLINE",
                            2: "MANUALLY_DISABLED",
                            3: "OFFLINE_LOWBAT",
                            4: "REMOVE_AND_READD",
                            5: "RESET_AND_READD"
                        }
                    },
                    native: {},
                });
                const status = keypad.getState();
                if (status !== undefined)
                    await setStateChangedWithTimestamp(this, keypad.getStateID(KeyPadStateID.STATE), status.value, status.timestamp);

                // Low Battery
                await this.setObjectNotExistsAsync(keypad.getStateID(KeyPadStateID.LOW_BATTERY), {
                    type: "state",
                    common: {
                        name: "Low Battery",
                        type: "boolean",
                        role: "indicator.lowbat",
                        read: true,
                        write: false,
                    },
                    native: {},
                });
                const low_battery = keypad.isBatteryLow();
                if (low_battery !== undefined)
                    await setStateChangedWithTimestamp(this, keypad.getStateID(KeyPadStateID.LOW_BATTERY), low_battery.value, low_battery.timestamp);
            } else if (device.isLock()) {
                const lock = device as Lock;

                // State
                await this.setObjectNotExistsAsync(lock.getStateID(LockStateID.STATE), {
                    type: "state",
                    common: {
                        name: "State",
                        type: "number",
                        role: "info.status",
                        read: true,
                        write: false,
                        states: {
                            0: "OFFLINE",
                            1: "ONLINE",
                            2: "MANUALLY_DISABLED",
                            3: "OFFLINE_LOWBAT",
                            4: "REMOVE_AND_READD",
                            5: "RESET_AND_READD"
                        }
                    },
                    native: {},
                });
                const status = lock.getState();
                if (status !== undefined)
                    await setStateChangedWithTimestamp(this, lock.getStateID(LockStateID.STATE), status.value, status.timestamp);

                // Battery
                await this.setObjectNotExistsAsync(lock.getStateID(LockStateID.BATTERY), {
                    type: "state",
                    common: {
                        name: "Battery",
                        type: "number",
                        role: "value.battery",
                        unit: "%",
                        min: 0,
                        max: 100,
                        read: true,
                        write: false,
                    },
                    native: {},
                });
                const battery = lock.getBatteryValue();
                if (battery !== undefined)
                    await setStateChangedWithTimestamp(this, lock.getStateID(LockStateID.BATTERY), battery.value, battery.timestamp);

                // Wifi RSSI
                await this.setObjectNotExistsAsync(lock.getStateID(LockStateID.WIFI_RSSI), {
                    type: "state",
                    common: {
                        name: "Wifi RSSI",
                        type: "number",
                        role: "value",
                        read: true,
                        write: false,
                    },
                    native: {},
                });
                const wifi_rssi = lock.getWifiRssi();
                if (wifi_rssi !== undefined)
                    await setStateChangedWithTimestamp(this, lock.getStateID(LockStateID.WIFI_RSSI), wifi_rssi.value, wifi_rssi.timestamp);

                // Lock/Unlock
                await this.setObjectNotExistsAsync(lock.getStateID(LockStateID.LOCK), {
                    type: "state",
                    common: {
                        name: "Lock",
                        type: "boolean",
                        role: "switch.enable",
                        read: true,
                        write: true
                    },
                    native: {},
                });
                const state = lock.isLocked();
                if (state !== undefined)
                    await setStateChangedWithTimestamp(this, lock.getStateID(LockStateID.LOCK), state.value, state.timestamp);

                // Lock Status
                await this.setObjectNotExistsAsync(lock.getStateID(LockStateID.LOCK_STATUS), {
                    type: "state",
                    common: {
                        name: "Lock Status",
                        type: "number",
                        role: "info.status",
                        read: true,
                        write: false,
                        states: {
                            1: "1",
                            2: "2",
                            3: "UNLOCKED",
                            4: "LOCKED",
                            5: "MECHANICAL_ANOMALY",
                            6: "6",
                            7: "7",
                        }
                    },
                    native: {},
                });
                const lock_status = lock.getLockStatus();
                if (lock_status !== undefined)
                    await setStateChangedWithTimestamp(this, lock.getStateID(LockStateID.LOCK_STATUS), lock_status.value, lock_status.timestamp);
            }
        });
    }

    private async handleStations(stations: Stations): Promise<void> {
        this.logger.debug(`count: ${Object.keys(stations).length}`);

        Object.values(stations).forEach(async station => {
            this.subscribeStates(`${station.getStateID("", 0)}.*`);

            await this.setObjectNotExistsAsync(station.getStateID("", 0), {
                type: "device",
                common: {
                    name: station.getName()
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(station.getStateID("", 1), {
                type: "channel",
                common: {
                    name: station.getStateChannel()
                },
                native: {},
            });

            // Station info
            // Name
            await this.setObjectNotExistsAsync(station.getStateID(StationStateID.NAME), {
                type: "state",
                common: {
                    name: "Name",
                    type: "string",
                    role: "info.name",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await setStateChangedAsync(this, station.getStateID(StationStateID.NAME), station.getName());

            // Model
            await this.setObjectNotExistsAsync(station.getStateID(StationStateID.MODEL), {
                type: "state",
                common: {
                    name: "Model",
                    type: "string",
                    role: "text",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await setStateChangedAsync(this, station.getStateID(StationStateID.MODEL), station.getModel());

            // Serial
            await this.setObjectNotExistsAsync(station.getStateID(StationStateID.SERIAL_NUMBER), {
                type: "state",
                common: {
                    name: "Serial number",
                    type: "string",
                    role: "text",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await setStateChangedAsync(this, station.getStateID(StationStateID.SERIAL_NUMBER), station.getSerial());

            // Software version
            await this.setObjectNotExistsAsync(station.getStateID(StationStateID.SOFTWARE_VERSION), {
                type: "state",
                common: {
                    name: "Software version",
                    type: "string",
                    role: "text",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await setStateChangedAsync(this, station.getStateID(StationStateID.SOFTWARE_VERSION), station.getSoftwareVersion());

            // Hardware version
            await this.setObjectNotExistsAsync(station.getStateID(StationStateID.HARDWARE_VERSION), {
                type: "state",
                common: {
                    name: "Hardware version",
                    type: "string",
                    role: "text",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await setStateChangedAsync(this, station.getStateID(StationStateID.HARDWARE_VERSION), station.getHardwareVersion());

            // MAC Address
            await this.setObjectNotExistsAsync(station.getStateID(StationStateID.MAC_ADDRESS), {
                type: "state",
                common: {
                    name: "MAC Address",
                    type: "string",
                    role: "info.mac",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await setStateChangedAsync(this, station.getStateID(StationStateID.MAC_ADDRESS), station.getMACAddress());

            // LAN IP Address
            await this.setObjectNotExistsAsync(station.getStateID(StationStateID.LAN_IP_ADDRESS), {
                type: "state",
                common: {
                    name: "LAN IP Address",
                    type: "string",
                    role: "info.ip",
                    read: true,
                    write: false,
                },
                native: {},
            });
            const lan_ip_address = station.getLANIPAddress();
            if (lan_ip_address !== undefined)
                await setStateChangedWithTimestamp(this, station.getStateID(StationStateID.LAN_IP_ADDRESS), lan_ip_address.value, lan_ip_address.timestamp);

            // Station Paramters
            // Guard Mode
            await this.setObjectNotExistsAsync(station.getStateID(StationStateID.GUARD_MODE), {
                type: "state",
                common: {
                    name: "Guard Mode",
                    type: "number",
                    role: "state",
                    read: true,
                    write: true,
                    states: {
                        0: "AWAY",
                        1: "HOME",
                        2: "SCHEDULE",
                        3: "CUSTOM1",
                        4: "CUSTOM2",
                        5: "CUSTOM3",
                        47: "GEO",
                        63: "DISARMED"
                    }
                },
                native: {},
            });
            const guard_mode = station.getGuardMode();
            if (guard_mode !== undefined)
                if (guard_mode.value !== -1)
                    await setStateChangedWithTimestamp(this, station.getStateID(StationStateID.GUARD_MODE), guard_mode.value, guard_mode.timestamp);

            // Current Alarm Mode
            await this.setObjectNotExistsAsync(station.getStateID(StationStateID.CURRENT_MODE), {
                type: "state",
                common: {
                    name: "Current Mode",
                    type: "number",
                    role: "value",
                    read: true,
                    write: false,
                    states: {
                        0: "AWAY",
                        1: "HOME",
                        63: "DISARMED"
                    }
                },
                native: {},
            });
            //APP_CMD_GET_ALARM_MODE = 1151
            const current_mode = station.getCurrentMode();
            if (current_mode !== undefined)
                await setStateChangedWithTimestamp(this, station.getStateID(StationStateID.CURRENT_MODE), current_mode.value, current_mode.timestamp);

            // Reboot station
            await this.setObjectNotExistsAsync(station.getStateID(StationStateID.REBOOT), {
                type: "state",
                common: {
                    name: "Reboot station",
                    type: "boolean",
                    role: "button.start",
                    read: false,
                    write: true,
                },
                native: {},
            });

        });
    }

    private downloadEventVideo(device: Device, event_time: number, full_path: string | undefined, cipher_id: number | undefined): void {
        this.logger.debug(`Device: ${device.getSerial()} full_path: ${full_path} cipher_id: ${cipher_id}`);
        try {
            if (!isEmpty(full_path) && cipher_id !== undefined) {
                const station = this.eufy.getStation(device.getStationSerial());

                if (station !== undefined) {
                    if (this.downloadEvent[device.getSerial()])
                        clearTimeout(this.downloadEvent[device.getSerial()]);

                    let videoLength = getVideoClipLength(device);
                    const time_passed = (new Date().getTime() - new Date(event_time).getTime()) / 1000;

                    if (time_passed >= videoLength)
                        videoLength = 1;
                    else
                        videoLength = videoLength - time_passed;

                    this.logger.info(`Downloading video event for device ${device.getSerial()} in ${videoLength} seconds...`);
                    this.downloadEvent[device.getSerial()] = setTimeout(async () => {
                        station.startDownload(device, full_path!, cipher_id);
                    }, videoLength * 1000);
                }
            }
        } catch (error) {
            this.logger.error(`Device: ${device.getSerial()} - Error: ${error}`);
        }
    }

    private async handlePushNotification(push_msg: PushMessage): Promise<void> {
        try {
            this.logger.debug(`push_msg: ${JSON.stringify(push_msg)}`);

            if (push_msg.type) {
                if (push_msg.type == ServerPushEvent.VERIFICATION) {
                    this.logger.debug(`Received push verification event: ${JSON.stringify(push_msg)}`);
                } else if (Device.isDoorbell(push_msg.type)) {
                    const device: Device | null = this.eufy.getDevice(push_msg.device_sn);
                    if (device) {
                        switch (push_msg.event_type) {
                            case DoorbellPushEvent.MOTION_DETECTION:
                                await this.setStateAsync(device.getStateID(DoorbellStateID.MOTION_DETECTED), { val: true, ack: true });
                                if (this.motionDetected[device.getSerial()])
                                    clearTimeout(this.motionDetected[device.getSerial()]);
                                this.motionDetected[device.getSerial()] = setTimeout(async () => {
                                    await this.setStateAsync(device.getStateID(DoorbellStateID.MOTION_DETECTED), { val: false, ack: true });
                                }, this.config.eventDuration * 1000);
                                if (!isEmpty(push_msg.pic_url)) {
                                    await saveImageStates(this, push_msg.pic_url!, push_msg.event_time, device.getStationSerial(), device.getSerial(), DataLocation.LAST_EVENT, device.getStateID(DoorbellStateID.LAST_EVENT_PICTURE_URL), device.getStateID(DoorbellStateID.LAST_EVENT_PICTURE_HTML), "Last captured picture").catch(() => {
                                        this.logger.error(`DoorbellPushEvent.MOTION_DETECTION of device ${device.getSerial()} - saveImageStates(): url ${push_msg.pic_url}`);
                                    });
                                }
                                break;
                            case DoorbellPushEvent.FACE_DETECTION:
                                await this.setStateAsync(device.getStateID(DoorbellStateID.PERSON_DETECTED), { val: true, ack: true });
                                await this.setStateAsync(device.getStateID(DoorbellStateID.LAST_PERSON_IDENTIFIED), { val: "Unknown", ack: true });
                                if (this.personDetected[device.getSerial()])
                                    clearTimeout(this.personDetected[device.getSerial()]);
                                this.personDetected[device.getSerial()] = setTimeout(async () => {
                                    await this.setStateAsync(device.getStateID(DoorbellStateID.PERSON_DETECTED), { val: false, ack: true });
                                }, this.config.eventDuration * 1000);
                                if (!isEmpty(push_msg.pic_url)) {
                                    await saveImageStates(this, push_msg.pic_url!, push_msg.event_time, device.getStationSerial(), device.getSerial(), DataLocation.LAST_EVENT, device.getStateID(DoorbellStateID.LAST_EVENT_PICTURE_URL), device.getStateID(DoorbellStateID.LAST_EVENT_PICTURE_HTML), "Last captured picture").catch(() => {
                                        this.logger.error(`DoorbellPushEvent.FACE_DETECTION of device ${device.getSerial()} - saveImageStates(): url ${push_msg.pic_url}`);
                                    });
                                }
                                break;
                            case DoorbellPushEvent.PRESS_DOORBELL:
                                await this.setStateAsync(device.getStateID(DoorbellStateID.RINGING), { val: true, ack: true });
                                if (this.ringing[device.getSerial()])
                                    clearTimeout(this.ringing[device.getSerial()]);
                                this.ringing[device.getSerial()] = setTimeout(async () => {
                                    await this.setStateAsync(device.getStateID(DoorbellStateID.RINGING), { val: false, ack: true });
                                }, this.config.eventDuration * 1000);
                                if (!isEmpty(push_msg.pic_url)) {
                                    await saveImageStates(this, push_msg.pic_url!, push_msg.event_time, device.getStationSerial(), device.getSerial(), DataLocation.LAST_EVENT, device.getStateID(DoorbellStateID.LAST_EVENT_PICTURE_URL), device.getStateID(DoorbellStateID.LAST_EVENT_PICTURE_HTML), "Last captured picture").catch(() => {
                                        this.logger.error(`DoorbellPushEvent.PRESS_DOORBELL of device ${device.getSerial()} - saveImageStates(): url ${push_msg.pic_url}`);
                                    });
                                }
                                break;
                            default:
                                this.logger.debug(`Unhandled doorbell push event: ${JSON.stringify(push_msg)}`);
                                break;
                        }
                        if (push_msg.push_count === 1)
                            this.downloadEventVideo(device, push_msg.event_time, push_msg.file_path, push_msg.cipher);
                    } else {
                        this.logger.debug(`DoorbellPushEvent - Device not found: ${push_msg.device_sn}`);
                    }
                } else if (Device.isIndoorCamera(push_msg.type)) {
                    const device = this.eufy.getDevice(push_msg.device_sn);

                    if (device) {
                        switch (push_msg.event_type) {
                            case IndoorPushEvent.MOTION_DETECTION:
                                await this.setStateAsync(device.getStateID(IndoorCameraStateID.MOTION_DETECTED), { val: true, ack: true });
                                if (this.motionDetected[device.getSerial()])
                                    clearTimeout(this.motionDetected[device.getSerial()]);
                                this.motionDetected[device.getSerial()] = setTimeout(async () => {
                                    await this.setStateAsync(device.getStateID(IndoorCameraStateID.MOTION_DETECTED), { val: false, ack: true });
                                }, this.config.eventDuration * 1000);
                                if (!isEmpty(push_msg.pic_url)) {
                                    await saveImageStates(this, push_msg.pic_url!, push_msg.event_time, device.getStationSerial(), device.getSerial(), DataLocation.LAST_EVENT, device.getStateID(IndoorCameraStateID.LAST_EVENT_PICTURE_URL), device.getStateID(IndoorCameraStateID.LAST_EVENT_PICTURE_HTML), "Last captured picture").catch(() => {
                                        this.logger.error(`IndoorPushEvent.MOTION_DETECTION of device ${device.getSerial()} - saveImageStates(): url ${push_msg.pic_url}`);
                                    });
                                }
                                break;
                            case IndoorPushEvent.FACE_DETECTION:
                                await this.setStateAsync(device.getStateID(IndoorCameraStateID.PERSON_DETECTED), { val: true, ack: true });
                                await this.setStateAsync(device.getStateID(IndoorCameraStateID.LAST_PERSON_IDENTIFIED), { val: "Unknown", ack: true });
                                if (this.personDetected[device.getSerial()])
                                    clearTimeout(this.personDetected[device.getSerial()]);
                                this.personDetected[device.getSerial()] = setTimeout(async () => {
                                    await this.setStateAsync(device.getStateID(IndoorCameraStateID.PERSON_DETECTED), { val: false, ack: true });
                                }, this.config.eventDuration * 1000);
                                if (!isEmpty(push_msg.pic_url)) {
                                    await saveImageStates(this, push_msg.pic_url!, push_msg.event_time, device.getStationSerial(), device.getSerial(), DataLocation.LAST_EVENT, device.getStateID(IndoorCameraStateID.LAST_EVENT_PICTURE_URL), device.getStateID(IndoorCameraStateID.LAST_EVENT_PICTURE_HTML), "Last captured picture").catch(() => {
                                        this.logger.error(`IndoorPushEvent.FACE_DETECTION of device ${device.getSerial()} - saveImageStates(): url ${push_msg.pic_url}`);
                                    });
                                }
                                break;
                            case IndoorPushEvent.CRYING_DETECTION:
                                await this.setStateAsync(device.getStateID(IndoorCameraStateID.CRYING_DETECTED), { val: true, ack: true });
                                if (this.cryingDetected[device.getSerial()])
                                    clearTimeout(this.cryingDetected[device.getSerial()]);
                                this.cryingDetected[device.getSerial()] = setTimeout(async () => {
                                    await this.setStateAsync(device.getStateID(IndoorCameraStateID.CRYING_DETECTED), { val: false, ack: true });
                                }, this.config.eventDuration * 1000);
                                if (!isEmpty(push_msg.pic_url)) {
                                    await saveImageStates(this, push_msg.pic_url!, push_msg.event_time, device.getStationSerial(), device.getSerial(), DataLocation.LAST_EVENT, device.getStateID(IndoorCameraStateID.LAST_EVENT_PICTURE_URL), device.getStateID(IndoorCameraStateID.LAST_EVENT_PICTURE_HTML), "Last captured picture").catch(() => {
                                        this.logger.error(`IndoorPushEvent.CRYIG_DETECTION of device ${device.getSerial()} - saveImageStates(): url ${push_msg.pic_url}`);
                                    });
                                }
                                break;
                            case IndoorPushEvent.SOUND_DETECTION:
                                await this.setStateAsync(device.getStateID(IndoorCameraStateID.SOUND_DETECTED), { val: true, ack: true });
                                if (this.soundDetected[device.getSerial()])
                                    clearTimeout(this.soundDetected[device.getSerial()]);
                                this.soundDetected[device.getSerial()] = setTimeout(async () => {
                                    await this.setStateAsync(device.getStateID(IndoorCameraStateID.SOUND_DETECTED), { val: false, ack: true });
                                }, this.config.eventDuration * 1000);
                                if (!isEmpty(push_msg.pic_url)) {
                                    await saveImageStates(this, push_msg.pic_url!, push_msg.event_time, device.getStationSerial(), device.getSerial(), DataLocation.LAST_EVENT, device.getStateID(IndoorCameraStateID.LAST_EVENT_PICTURE_URL), device.getStateID(IndoorCameraStateID.LAST_EVENT_PICTURE_HTML), "Last captured picture").catch(() => {
                                        this.logger.error(`IndoorPushEvent.SOUND_DETECTION of device ${device.getSerial()} - saveImageStates(): url ${push_msg.pic_url}`);
                                    });
                                }
                                break;
                            case IndoorPushEvent.PET_DETECTION:
                                await this.setStateAsync(device.getStateID(IndoorCameraStateID.PET_DETECTED), { val: true, ack: true });
                                if (this.petDetected[device.getSerial()])
                                    clearTimeout(this.petDetected[device.getSerial()]);
                                this.petDetected[device.getSerial()] = setTimeout(async () => {
                                    await this.setStateAsync(device.getStateID(IndoorCameraStateID.PET_DETECTED), { val: false, ack: true });
                                }, this.config.eventDuration * 1000);
                                if (!isEmpty(push_msg.pic_url)) {
                                    await saveImageStates(this, push_msg.pic_url!, push_msg.event_time, device.getStationSerial(), device.getSerial(), DataLocation.LAST_EVENT, device.getStateID(IndoorCameraStateID.LAST_EVENT_PICTURE_URL), device.getStateID(IndoorCameraStateID.LAST_EVENT_PICTURE_HTML), "Last captured picture").catch(() => {
                                        this.logger.error(`IndoorPushEvent.PET_DETECTION of device ${device.getSerial()} - saveImageStates(): url ${push_msg.pic_url}`);
                                    });
                                }
                                break;
                            default:
                                this.logger.debug(`Unhandled indoor camera push event: ${JSON.stringify(push_msg)}`);
                                break;
                        }
                        if (push_msg.push_count === 1)
                            this.downloadEventVideo(device, push_msg.event_time, push_msg.file_path, push_msg.cipher);
                    } else {
                        this.logger.debug(`IndoorPushEvent - Device not found: ${push_msg.device_sn}`);
                    }
                } else if (push_msg.type) {
                    if (push_msg.event_type) {
                        let device: Device | null;
                        switch (push_msg.event_type) {
                            case CusPushEvent.SECURITY: // Cam movement detected event
                                device = this.eufy.getDevice(push_msg.device_sn);

                                if (device) {
                                    if (push_msg.fetch_id) {
                                        if (!isEmpty(push_msg.pic_url)) {
                                            await saveImageStates(this, push_msg.pic_url!, push_msg.event_time, device.getStationSerial(), device.getSerial(), DataLocation.LAST_EVENT, device.getStateID(CameraStateID.LAST_EVENT_PICTURE_URL), device.getStateID(CameraStateID.LAST_EVENT_PICTURE_HTML), "Last captured picture").catch(() => {
                                                this.logger.error(`CusPushEvent.SECURITY of device ${device!.getSerial()} - saveImageStates(): url ${push_msg.pic_url}`);
                                            });
                                            if (isEmpty(push_msg.person_name)) {
                                                // Someone spotted
                                                await this.setStateAsync(device.getStateID(CameraStateID.PERSON_DETECTED), { val: true, ack: true });
                                                await this.setStateAsync(device.getStateID(CameraStateID.LAST_PERSON_IDENTIFIED), { val: "Unknown", ack: true });
                                                if (this.personDetected[device.getSerial()])
                                                    clearTimeout(this.personDetected[device.getSerial()]);
                                                this.personDetected[device.getSerial()] = setTimeout(async () => {
                                                    await this.setStateAsync(device!.getStateID(CameraStateID.PERSON_DETECTED), { val: false, ack: true });
                                                }, this.config.eventDuration * 1000);
                                            } else {
                                                // Person identified
                                                await this.setStateAsync(device.getStateID(CameraStateID.PERSON_DETECTED), { val: true, ack: true });
                                                await this.setStateAsync(device.getStateID(CameraStateID.LAST_PERSON_IDENTIFIED), { val: !isEmpty(push_msg.person_name) ? push_msg.person_name! : "Unknown", ack: true });
                                                if (this.personDetected[device.getSerial()])
                                                    clearTimeout(this.personDetected[device.getSerial()]);
                                                this.personDetected[device.getSerial()] = setTimeout(async () => {
                                                    await this.setStateAsync(device!.getStateID(CameraStateID.PERSON_DETECTED), { val: false, ack: true });
                                                }, this.config.eventDuration * 1000);
                                            }
                                        } else {
                                            // Someone spotted
                                            await this.setStateAsync(device.getStateID(CameraStateID.PERSON_DETECTED), { val: true, ack: true });
                                            await this.setStateAsync(device.getStateID(CameraStateID.LAST_PERSON_IDENTIFIED), { val: "Unknown", ack: true });
                                            if (this.personDetected[device.getSerial()])
                                                clearTimeout(this.personDetected[device.getSerial()]);
                                            this.personDetected[device.getSerial()] = setTimeout(async () => {
                                                await this.setStateAsync(device!.getStateID(CameraStateID.PERSON_DETECTED), { val: false, ack: true });
                                            }, this.config.eventDuration * 1000);
                                        }
                                    } else {
                                        // Motion detected
                                        await this.setStateAsync(device.getStateID(CameraStateID.MOTION_DETECTED), { val: true, ack: true });
                                        if (this.motionDetected[device.getSerial()])
                                            clearTimeout(this.motionDetected[device.getSerial()]);
                                        this.motionDetected[device.getSerial()] = setTimeout(async () => {
                                            await this.setStateAsync(device!.getStateID(CameraStateID.MOTION_DETECTED), { val: false, ack: true });
                                        }, this.config.eventDuration * 1000);
                                    }
                                    if (push_msg.push_count === 1)
                                        this.downloadEventVideo(device, push_msg.event_time, push_msg.file_path, push_msg.cipher);
                                } else {
                                    this.logger.debug(`CusPushEvent.SECURITY - Device not found: ${push_msg.device_sn}`);
                                }
                                break;

                            case CusPushEvent.MODE_SWITCH: // Changing Guard mode event
                                this.logger.info(`Received push notification for changing guard mode (guard_mode: ${push_msg.station_guard_mode} current_mode: ${push_msg.station_current_mode}) for station ${push_msg.station_sn}}.`);
                                const station = this.eufy.getStation(push_msg.station_sn);
                                if (station) {
                                    if (push_msg.station_guard_mode !== undefined && push_msg.station_current_mode !== undefined) {
                                        await setStateChangedWithTimestamp(this, station.getStateID(StationStateID.GUARD_MODE), push_msg.station_guard_mode, push_msg.event_time);
                                        await setStateChangedWithTimestamp(this, station.getStateID(StationStateID.CURRENT_MODE), push_msg.station_current_mode, push_msg.event_time);
                                    } else {
                                        this.logger.warn(`Station MODE_SWITCH event (${push_msg.event_type}): Missing required data to handle event: ${JSON.stringify(push_msg)}`);
                                    }
                                } else {
                                    this.logger.warn(`Station MODE_SWITCH event (${push_msg.event_type}): Station Unknown: ${push_msg.station_sn}`);
                                }
                                break;

                            case CusPushEvent.DOOR_SENSOR: // EntrySensor open/close change event
                                device = this.eufy.getDevice(push_msg.device_sn);
                                if (device) {
                                    await setStateChangedAsync(this, device.getStateID(EntrySensorStateID.SENSOR_OPEN), push_msg.sensor_open ? push_msg.sensor_open : false);
                                } else {
                                    this.logger.debug(`CusPushEvent.DOOR_SENSOR - Device not found: ${push_msg.device_sn}`);
                                }
                                break;

                            case CusPushEvent.MOTION_SENSOR_PIR: // MotionSensor movement detected event
                                device = this.eufy.getDevice(push_msg.device_sn);
                                if (device) {
                                    await this.setStateAsync(device.getStateID(MotionSensorStateID.MOTION_DETECTED), { val: true, ack: true });
                                    if (this.motionDetected[device.getSerial()])
                                        clearTimeout(this.motionDetected[device.getSerial()]);
                                    this.motionDetected[device.getSerial()] = setTimeout(async () => {
                                        await this.setStateAsync(device!.getStateID(MotionSensorStateID.MOTION_DETECTED), { val: false, ack: true });
                                    }, MotionSensor.MOTION_COOLDOWN_MS);
                                } else {
                                    this.logger.debug(`CusPushEvent.MOTION_SENSOR_PIR - Device not found: ${push_msg.device_sn}`);
                                }
                                break;

                            default:
                                this.logger.debug(`Unhandled push event: ${JSON.stringify(push_msg)}`);
                                break;
                        }
                    } else {
                        this.logger.warn(`Cus unknown push data: ${JSON.stringify(push_msg)}`);
                    }
                } else {
                    this.logger.warn(`Unhandled push event - data: ${JSON.stringify(push_msg)}`);
                }
            }
        } catch (error) {
            this.logger.error("Error:", error);
        }
    }

    private async onConnect(): Promise<void> {
        await this.setStateAsync("info.connection", { val: true, ack: true });
        await this.refreshData(this);

        const api = this.eufy.getApi();
        const api_base = api.getAPIBase();
        const token = api.getToken();
        let token_expiration = api.getTokenExpiration();
        const trusted_token_expiration = api.getTrustedTokenExpiration();

        if (token_expiration?.getTime() !== trusted_token_expiration.getTime())
            try {
                const trusted_devices = await api.listTrustDevice();
                trusted_devices.forEach(trusted_device => {
                    if (trusted_device.is_current_device === 1) {
                        token_expiration = trusted_token_expiration;
                        api.setTokenExpiration(token_expiration);
                        this.logger.debug(`onConnect(): This device is trusted. Token expiration extended to: ${token_expiration})`);
                    }
                });
            } catch (error) {
                this.logger.error(`trusted_devices - Error:`, error);
            }

        if (api_base) {
            this.logger.debug(`Save api_base - api_base: ${api_base}`);
            this.setAPIBase(api_base);
        }

        if (token && token_expiration) {
            this.logger.debug(`Save token and expiration - token: ${token} token_expiration: ${token_expiration}`);
            this.setCloudToken(token, token_expiration);
        }

        this.eufy.registerPushNotifications(this.getPersistentData().push_credentials, this.getPersistentData().push_persistentIds);
        let connectionType = P2PConnectionType.PREFER_LOCAL;
        if (this.config.p2pConnectionType === "only_local") {
            connectionType = P2PConnectionType.ONLY_LOCAL;
        } else if (this.config.p2pConnectionType === "only_local") {
            connectionType = P2PConnectionType.QUICKEST;
        }
        Object.values(this.eufy.getStations()).forEach(function (station: Station) {
            station.connect(connectionType, true);
        });
    }

    private async onClose(): Promise<void> {
        await this.setStateAsync("info.connection", { val: false, ack: true });
    }

    public setAPIBase(api_base: string): void {
        this.persistentData.api_base = api_base;
        this.writePersistentData();
    }

    public setCloudToken(token: string, expiration: Date): void {
        this.persistentData.cloud_token = token;
        this.persistentData.cloud_token_expiration = expiration.getTime();
        this.writePersistentData();
    }

    public setPushCredentials(credentials: Credentials | undefined): void {
        this.persistentData.push_credentials = credentials;
        this.writePersistentData();
    }

    public getPersistentData(): PersistentData {
        return this.persistentData;
    }

    public setPushPersistentIds(persistentIds: string[]): void {
        this.persistentData.push_persistentIds = persistentIds;
        //this.writePersistentData();
    }

    private async onStartLivestream(station: Station, device: Device, url: string): Promise<void> {
        this.logger.debug(`Station: ${station.getSerial()} device: ${device.getSerial()} url: ${url}`);
        this.setStateAsync(device.getStateID(CameraStateID.LIVESTREAM), { val: url, ack: true });
    }

    private async onStopLivestream(station: Station, device: Device): Promise<void> {
        this.logger.debug(`Station: ${station.getSerial()} device: ${device.getSerial()}`);
        this.delStateAsync(device.getStateID(CameraStateID.LIVESTREAM));
    }

    private onPushConnect(): void {
        this.setStateAsync("info.push_connection", { val: true, ack: true });
    }

    private onPushClose(): void {
        this.setStateAsync("info.push_connection", { val: false, ack: true });
    }

}

if (module.parent) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new EufySecurity(options);
} else {
    // otherwise start the instance directly
    (() => new EufySecurity())();
}