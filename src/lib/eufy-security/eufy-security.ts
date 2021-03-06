import { TypedEmitter } from "tiny-typed-emitter";
import { HTTPApi, Device, Camera, Lock, MotionSensor, EntrySensor, Keypad, UnknownDevice, Devices, FullDevices, Hubs, Station, Stations, ParamType, FullDeviceResponse, HubResponse, Credentials, PushMessage, CommandResult, CommandType, ErrorCode, StreamMetadata, PushNotificationService, AuthResult, DoorbellCamera, FloodlightCamera, IndoorCamera, SoloCamera, BatteryDoorbellCamera, DeviceType, P2PConnectionType, RawValues } from "eufy-security-client";
import { Readable } from "stream";
import fse from "fs-extra";

import { CameraStateID, LockStateID, StationStateID, StoppablePromise } from "./types";
import { EufySecurityEvents } from "./interfaces";
import { EufySecurity as EufySecurityAdapter } from "./../../main";
import { getDataFilePath, getImageAsHTML, getState, moveFiles, removeFiles, setStateChangedWithTimestamp, setStateWithTimestamp, sleep } from "./utils";
import { ffmpegPreviewImage, ffmpegRTMPToHls, ffmpegStreamToHls } from "./video";
import { DataLocation, IMAGE_FILE_JPEG_EXT, STREAM_FILE_NAME_EXT } from "./types";
import { ioBrokerLogger } from "./log";

export class EufySecurity extends TypedEmitter<EufySecurityEvents> {

    private adapter: EufySecurityAdapter;

    private username: string;
    private password: string;

    private log: ioBrokerLogger;

    private api: HTTPApi;

    private stations: Stations = {};
    private devices: Devices = {};

    private camera_max_livestream_seconds = 30;
    private camera_livestream_timeout: Map<string, NodeJS.Timeout> = new Map<string, NodeJS.Timeout>();
    private rtmpFFmpegPromise: Map<string, StoppablePromise> = new Map<string, StoppablePromise>();

    private pushService: PushNotificationService;
    private connected = false;

    constructor(adapter: EufySecurityAdapter, log: ioBrokerLogger, country: string | undefined, language: string | undefined) {
        super();

        this.adapter = adapter;
        this.username = this.adapter.config.username;
        this.password = this.adapter.config.password;
        this.camera_max_livestream_seconds = this.adapter.config.maxLivestreamDuration;
        this.log = log;
        this.api = new HTTPApi(this.username, this.password, this.log);

        try {
            if (country)
                this.api.setCountry(country);
        } catch (error) {}

        try {
            if (language)
                this.api.setLanguage(language);
        } catch (error) {}
        this.api.setPhoneModel("iobroker");

        this.api.on("hubs", (hubs) => this.handleHubs(hubs));
        this.api.on("devices", (devices) => this.handleDevices(devices));
        this.api.on("close", () => this.onAPIClose());
        this.api.on("connect", () => this.onAPIConnect());
        this.pushService = new PushNotificationService(this.log);
        this.pushService.on("connect", async (token: string) => {
            const registered = await this.api.registerPushToken(token);
            const checked = await this.api.checkPushToken();

            if (registered && checked) {
                this.log.info("Push notification connection successfully established.");
                this.emit("push connect");
            } else {
                this.emit("push close");
            }
        });
        this.pushService.on("credential", (credentials: Credentials) => {
            this.adapter.setPushCredentials(credentials);
        });
        this.pushService.on("message", (message: PushMessage) => {
            this.emit("push message", message);
        })
        this.pushService.on("close", () => {
            this.emit("push close");
        });
    }

    public addStation(station: Station): void {
        const serial = station.getSerial();
        if (serial && !Object.keys(this.stations).includes(serial))
            this.stations[serial] = station;
        else
            throw new Error(`Station with this serial ${station.getSerial()} exists already and couldn't be added again!`);
    }

    public updateStation(hub: HubResponse): void {
        if (Object.keys(this.stations).includes(hub.station_sn))
            this.stations[hub.station_sn].update(hub);
        else
            throw new Error(`Station with this serial ${hub.station_sn} doesn't exists and couldn't be updated!`);
    }

    public addDevice(device: Device): void {
        const serial = device.getSerial()
        if (serial && !Object.keys(this.devices).includes(serial))
            this.devices[serial] = device;
        else
            throw new Error(`Device with this serial ${device.getSerial()} exists already and couldn't be added again!`);
    }

    public updateDevice(device: FullDeviceResponse): void {
        if (Object.keys(this.devices).includes(device.device_sn))
            this.devices[device.device_sn].update(device)
        else
            throw new Error(`Device with this serial ${device.device_sn} doesn't exists and couldn't be updated!`);
    }

    public getDevices(): Devices {
        return this.devices;
    }

    public getDevice(device_sn: string): Device | null {
        if (Object.keys(this.devices).includes(device_sn))
            return this.devices[device_sn];
        return null;
    }

    public getStationDevice(station_sn: string, channel: number): Device {
        for (const device of Object.values(this.devices)) {
            if ((device.getStationSerial() === station_sn && device.getChannel() === channel) || (device.getStationSerial() === station_sn && device.getSerial() === station_sn)) {
                return device;
            }
        }
        throw new Error(`No device with channel ${channel} found on station with serial number: ${station_sn}!`);
    }

    public getStations(): Stations {
        return this.stations;
    }

    public getStation(station_sn: string): Station {
        if (Object.keys(this.stations).includes(station_sn))
            return this.stations[station_sn];
        throw new Error(`No station with this serial number: ${station_sn}!`);
    }

    public getApi(): HTTPApi {
        return this.api;
    }

    public async connectToStation(station_sn: string, p2pConnectionType: P2PConnectionType = P2PConnectionType.PREFER_LOCAL): Promise<void> {
        if (Object.keys(this.stations).includes(station_sn))
            this.stations[station_sn].connect(p2pConnectionType, true);
        else
            throw new Error(`No station with this serial number: ${station_sn}!`);
    }

    private handleHubs(hubs: Hubs): void {
        this.log.debug(`Hubs: ${Object.keys(hubs).length}`);
        const stations_sns: string[] = Object.keys(this.stations);
        for (const hub of Object.values(hubs)) {
            if (stations_sns.includes(hub.station_sn)) {
                this.updateStation(hub);
            } else {
                const station = new Station(this.api, hub);
                station.on("connect", (station: Station) => this.onConnect(station));
                station.on("close", (station: Station) => this.onClose(station));
                station.on("raw device property changed", (device_sn: string, params: RawValues) => this.updateDeviceParameter(device_sn, params));
                station.on("raw property changed", (station: Station, type: number, value: string, modified: number) => this.stationParameterChanged(station, type, value, modified));
                station.on("command result", (station: Station, result: CommandResult) => this.stationP2PCommandResult(station, result));
                station.on("download start", (station: Station, channel: number, metadata: StreamMetadata, videoStream: Readable, audioStream: Readable) => this.onStartDownload(station, channel, metadata, videoStream, audioStream));
                station.on("download finish", (station: Station, channel: number) => this.onFinishDownload(station, channel));
                station.on("livestream start", (station: Station, channel: number, metadata: StreamMetadata, videoStream: Readable, audioStream: Readable) => this.onStartLivestream(station, channel, metadata, videoStream, audioStream));
                station.on("livestream stop", (station: Station, channel: number) => this.onStopLivestream(station, channel));
                station.on("rtsp url", (station: Station, channel: number, rtsp_url: string, modified: number) => this.onRTSPUrl(station, channel, rtsp_url, modified));
                station.update(hub);
                this.addStation(station);
            }
        }

        const station_count = Object.keys(this.stations).length;
        this.log.debug(`Stations: ${station_count}`);
        if (station_count > 0) {
            this.emit("stations", this.stations);
        }
    }

    private onConnect(station: Station): void {
        if (station.getDeviceType() !== DeviceType.DOORBELL)
            station.getCameraInfo();
    }

    private onClose(station: Station): void {
        try {
            for (const device_sn of this.camera_livestream_timeout.keys()) {
                const device = this.getDevice(device_sn);
                if (device !== null && device.getStationSerial() === station.getSerial()) {
                    clearTimeout(this.camera_livestream_timeout.get(device_sn)!);
                    this.camera_livestream_timeout.delete(device_sn);
                }
            }
        } catch (error) {
            this.log.error(`Station: ${station.getSerial()} - Error: ${error}`);
        }
    }

    private async stationP2PCommandResult(station: Station, result: CommandResult): Promise<void> {
        if (result.return_code === 0) {
            const state_name = getState(result.command_type);
            if (state_name) {
                if (result.channel === Station.CHANNEL) {
                    // Station
                    if (state_name) {
                        const state_id = station.getStateID(state_name);
                        const state = await this.adapter.getStateAsync(state_id);
                        this.adapter.setStateAsync(state_id, {...state as ioBroker.State, ack: true });
                        this.log.debug(`State ${state_id} aknowledged - station: ${station.getSerial()} result: ${JSON.stringify(result)}`);
                    } else {
                        this.log.debug(`Loading current state not possible - station: ${station.getSerial()} result: ${JSON.stringify(result)}`);
                    }
                } else {
                    // Device
                    try {
                        const device = this.getStationDevice(station.getSerial(), result.channel);
                        const state_id = device.getStateID(state_name);
                        const state = await this.adapter.getStateAsync(state_id);
                        this.adapter.setStateAsync(state_id, { ...state as ioBroker.State, ack: true });
                        this.log.debug(`State ${state_id} aknowledged - station: ${station.getSerial()} device: ${device.getSerial()} result: ${JSON.stringify(result)}`);
                    } catch(error) {
                        this.log.error(`Error: ${error} - station: ${station.getSerial()} result: ${JSON.stringify(result)}`);
                    }
                }
            } else if (result.command_type === CommandType.CMD_DOORLOCK_DATA_PASS_THROUGH) {
                // TODO: Implement third level of command verification for ESL?
                const device = this.getStationDevice(station.getSerial(), result.channel);
                const states = await this.adapter.getStatesAsync(`${device.getStateID("", 1)}.*`);
                for (const state in states) {
                    if (!states[state].ack)
                        this.adapter.setStateAsync(state, { ...states[state] as ioBroker.State, ack: true });
                }
            } else {
                this.log.debug(`No mapping for state <> command_type - station: ${station.getSerial()} result: ${JSON.stringify(result)}`);
            }
        } else if (result.return_code !== 0 && result.command_type === CommandType.CMD_START_REALTIME_MEDIA) {
            this.log.debug(`Station: ${station.getSerial()} command ${CommandType[result.command_type]} failed with error: ${ErrorCode[result.return_code]} (${result.return_code}) fallback to RTMP livestream...`);
            try {
                const device = this.getStationDevice(station.getSerial(), result.channel);
                if (device.isCamera())
                    this._startRtmpLivestream(station, device as Camera);
            } catch (error) {
                this.log.error(`Station: ${station.getSerial()} command ${CommandType[result.command_type]} RTMP fallback failed - Error ${error}`);
            }
        } else {
            this.log.error(`Station: ${station.getSerial()} command ${CommandType[result.command_type]} failed with error: ${ErrorCode[result.return_code]} (${result.return_code})`);
        }
    }

    private handleDevices(devices: FullDevices): void {
        this.log.debug(`Devices: ${Object.keys(devices).length}`);
        const device_sns: string[] = Object.keys(this.devices);
        for (const device of Object.values(devices)) {

            if (device_sns.includes(device.device_sn)) {
                //if (!this.getStation(device.station_sn).isConnected())
                this.updateDevice(device);
            } else {
                let new_device: Device;

                if (Device.isIndoorCamera(device.device_type)) {
                    new_device = new IndoorCamera(this.api, device);
                } else if (Device.isSoloCamera(device.device_type)) {
                    new_device = new SoloCamera(this.api, device);
                } else if (Device.isBatteryDoorbell(device.device_type) || Device.isBatteryDoorbell2(device.device_type)) {
                    new_device = new BatteryDoorbellCamera(this.api, device);
                } else if (Device.isWiredDoorbell(device.device_type)) {
                    new_device = new DoorbellCamera(this.api, device);
                } else if (Device.isFloodLight(device.device_type)) {
                    new_device = new FloodlightCamera(this.api, device);
                } else if (Device.isCamera(device.device_type)) {
                    new_device = new Camera(this.api, device);
                } else if (Device.isLock(device.device_type)) {
                    new_device = new Lock(this.api, device);
                } else if (Device.isMotionSensor(device.device_type)) {
                    new_device = new MotionSensor(this.api, device);
                } else if (Device.isEntrySensor(device.device_type)) {
                    new_device = new EntrySensor(this.api, device);
                } else if (Device.isKeyPad(device.device_type)) {
                    new_device = new Keypad(this.api, device);
                } else {
                    new_device = new UnknownDevice(this.api, device);
                }

                new_device.on("raw property changed", (device: Device, type: number, value: string, modified: number) => this.deviceParameterChanged(device, type, value, modified))
                new_device.update(device);
                this.addDevice(new_device);
            }
        }
        const device_count = Object.keys(this.devices).length;
        this.log.debug(`Devices: ${device_count}`);
        if (device_count > 0) {
            this.emit("devices", this.devices);
        }
    }

    public async refreshData(): Promise<void> {
        await this.api.updateDeviceInfo();
        Object.values(this.stations).forEach(async (station: Station) => {
            if (station.isConnected() && station.getDeviceType() !== DeviceType.DOORBELL)
                await station.getCameraInfo();
        });
    }

    public close(): void {

        // if there is a camera with livestream running stop it (incl. timeout)
        for (const device_sn of this.camera_livestream_timeout.keys()) {
            this.stopLivestream(device_sn);
        }

        this.pushService.close();

        Object.values(this.stations).forEach(station => {
            station.close();
        });

        Object.values(this.devices).forEach(device => {
            device.destroy();
        });

        if (this.connected)
            this.emit("close");

        this.connected = false;
    }

    public setCameraMaxLivestreamDuration(seconds: number): void {
        this.camera_max_livestream_seconds = seconds;
    }

    public getCameraMaxLivestreamDuration(): number {
        return this.camera_max_livestream_seconds;
    }

    public async registerPushNotifications(credentials?: Credentials, persistentIds?: string[]): Promise<void> {
        if (credentials)
            this.pushService.setCredentials(credentials);
        if (persistentIds)
            this.pushService.setPersistentIds(persistentIds);

        this.pushService.open();
    }

    public async logon(verify_code?:string|null): Promise<void> {
        if (verify_code) {
            await this.api.addTrustDevice(verify_code).then(result => {
                if (result)
                    this.emit("connect");
            });
        } else {
            switch (await this.api.authenticate()) {
                case AuthResult.SEND_VERIFY_CODE:
                    break;
                case AuthResult.RENEW:
                    this.log.debug("Renew token");
                    this.api.authenticate();
                    /*const result = await this.api.authenticate();
                    if (result == "ok") {
                        this.emit("connect");
                    }*/
                    break;
                case AuthResult.ERROR:
                    this.log.error("Token error");
                    break;
                case AuthResult.OK:
                    //this.emit("connect");
                    break;
            }
        }
    }

    public getPushPersistentIds(): string[] {
        return this.pushService.getPersistentIds();
    }

    private stationParameterChanged(station: Station, type: number, value: string, modified: number): void {
        //this.log.debug(`EufySecurity.stationParameterChanged(): station: ${station.getSerial()} type: ${type} value: ${value} modified: ${modified}`);
        if (type == CommandType.CMD_SET_ARMING) {
            try {
                setStateChangedWithTimestamp(this.adapter, station.getStateID(StationStateID.GUARD_MODE), Number.parseInt(value), modified);
            } catch (error) {
                this.log.error(`Station: ${station.getSerial()} GUARD_MODE Error: ${error}`);
            }
        } else if (type == CommandType.CMD_GET_ALARM_MODE) {
            try {
                setStateChangedWithTimestamp(this.adapter, station.getStateID(StationStateID.CURRENT_MODE), Number.parseInt(value), modified);
            } catch (error) {
                this.log.error(`Station: ${station.getSerial()} CURRENT_MODE Error: ${error}`);
            }
        }
    }

    private updateDeviceParameter(device_sn: string, params: RawValues): void {
        this.log.debug(`Device: ${device_sn} params: ${JSON.stringify(params)}`);
        const device = this.getDevice(device_sn);
        if (device)
            device.updateRawProperties(params);
    }

    private deviceParameterChanged(device: Device, type: number, value: string, modified: number): void {
        this.log.debug(`Device: ${device.getSerial()} type: ${type} value: ${value} modified: ${modified}`);
        if (type == CommandType.CMD_GET_BATTERY) {
            try {
                setStateChangedWithTimestamp(this.adapter, device.getStateID(CameraStateID.BATTERY), Number.parseInt(value), modified);
            } catch (error) {
                this.log.error(`Device: ${device.getSerial()} BATTERY Error:`, error);
            }
        } else if (type == CommandType.CMD_GET_BATTERY_TEMP) {
            try {
                setStateChangedWithTimestamp(this.adapter, device.getStateID(CameraStateID.BATTERY_TEMPERATURE), Number.parseInt(value), modified);
            } catch (error) {
                this.log.error(`Device: ${device.getSerial()} BATTERY_TEMP Error:`, error);
            }
        } else if (type == CommandType.CMD_GET_WIFI_RSSI) {
            try {
                setStateChangedWithTimestamp(this.adapter, device.getStateID(CameraStateID.WIFI_RSSI), Number.parseInt(value), modified);
            } catch (error) {
                this.log.error(`Device: ${device.getSerial()} WIFI_RSSI Error:`, error);
            }
        } else if (type == CommandType.CMD_DEVS_SWITCH || type == 99904 || type === ParamType.OPEN_DEVICE) {
            try {
                const enabled = device.isEnabled();
                setStateChangedWithTimestamp(this.adapter, device.getStateID(CameraStateID.ENABLED), enabled.value, modified);
            } catch (error) {
                this.log.error(`Device: ${device.getSerial()} ENABLED Error:`, error);
            }
        } else if (type == CommandType.CMD_SET_DEVS_OSD) {
            try {
                setStateChangedWithTimestamp(this.adapter, device.getStateID(CameraStateID.WATERMARK), Number.parseInt(value), modified);
            } catch (error) {
                this.log.error(`Device: ${device.getSerial()} WATERMARK Error:`, error);
            }
        } else if (type == CommandType.CMD_EAS_SWITCH) {
            try {
                setStateChangedWithTimestamp(this.adapter, device.getStateID(CameraStateID.ANTITHEFT_DETECTION), value === "1" ? true : false, modified);
            } catch (error) {
                this.log.error(`Device: ${device.getSerial()} ANTITHEFT_DETECTION Error:`, error);
            }
        } else if (type == CommandType.CMD_IRCUT_SWITCH) {
            try {
                setStateChangedWithTimestamp(this.adapter, device.getStateID(CameraStateID.AUTO_NIGHTVISION), value === "1" ? true : false, modified);
            } catch (error) {
                this.log.error(`Device: ${device.getSerial()} AUTO_NIGHTVISION Error:`, error);
            }
        } else if (type == CommandType.CMD_PIR_SWITCH) {
            try {
                setStateChangedWithTimestamp(this.adapter, device.getStateID(CameraStateID.MOTION_DETECTION), value === "1" ? true : false, modified);
            } catch (error) {
                this.log.error(`Device: ${device.getSerial()} MOTION_DETECTION Error:`, error);
            }
        } else if (type == CommandType.CMD_NAS_SWITCH) {
            try {
                setStateChangedWithTimestamp(this.adapter, device.getStateID(CameraStateID.RTSP_STREAM), value === "1" ? true : false, modified);
                if (value === "0") {
                    this.adapter.delStateAsync(device.getStateID(CameraStateID.RTSP_STREAM_URL));
                }
            } catch (error) {
                this.log.error(`Device: ${device.getSerial()} RTSP_STREAM Error:`, error);
            }
        } else if (type == CommandType.CMD_DEV_LED_SWITCH) {
            try {
                setStateChangedWithTimestamp(this.adapter, device.getStateID(CameraStateID.LED_STATUS), value === "1" ? true : false, modified);
            } catch (error) {
                this.log.error(`Device: ${device.getSerial()} LED_STATUS Error:`, error);
            }
        } else if (type == CommandType.CMD_GET_DEV_STATUS) {
            try {
                setStateChangedWithTimestamp(this.adapter, device.getStateID(CameraStateID.STATE), Number.parseInt(value), modified);
            } catch (error) {
                this.log.error(`Device: ${device.getSerial()} STATE Error:`, error);
            }
        } else if (type == CommandType.CMD_DOORLOCK_GET_STATE) {
            try {
                setStateChangedWithTimestamp(this.adapter, device.getStateID(LockStateID.LOCK_STATUS), Number.parseInt(value), modified);
                setStateChangedWithTimestamp(this.adapter, device.getStateID(LockStateID.LOCK), Number.parseInt(value) === 4 ? true : false, modified);
            } catch (error) {
                this.log.error(`Device: ${device.getSerial()} LOCK_STATUS Error:`, error);
            }
        }
    }

    private onAPIClose(): void {
        this.connected = false;
        this.emit("close");
    }

    private onAPIConnect(): void {
        this.connected = true;
        this.emit("connect");
    }

    private async onFinishDownload(station: Station, channel: number): Promise<void> {
        this.log.trace(`Station: ${station.getSerial()} channel: ${channel}`);
    }

    private async onStartDownload(station: Station, channel: number, metadata: StreamMetadata, videostream: Readable, audiostream: Readable): Promise<void> {
        this.log.trace(`Station: ${station.getSerial()} channel: ${channel}`);
        try {
            const device = this.getStationDevice(station.getSerial(), channel);
            try {
                await removeFiles(this.adapter, station.getSerial(), DataLocation.TEMP, device.getSerial()).catch();
                const file_path = getDataFilePath(this.adapter, station.getSerial(), DataLocation.TEMP, `${device.getSerial()}${STREAM_FILE_NAME_EXT}`);

                ffmpegStreamToHls(this.adapter.config, this.adapter.namespace, metadata, videostream, audiostream, file_path, this.log)
                    .then(() => {
                        if (fse.pathExistsSync(file_path)) {
                            removeFiles(this.adapter, station.getSerial(), DataLocation.LAST_EVENT, device.getSerial());
                            return true;
                        }
                        return false;
                    })
                    .then((result) => {
                        if (result)
                            moveFiles(this.adapter, station.getSerial(), device.getSerial(), DataLocation.TEMP, DataLocation.LAST_EVENT);
                        return result;
                    })
                    .then((result) => {
                        if (result) {
                            const filename_without_ext = getDataFilePath(this.adapter, station.getSerial(), DataLocation.LAST_EVENT, device.getSerial());
                            setStateWithTimestamp(this.adapter, device.getStateID(CameraStateID.LAST_EVENT_VIDEO_URL), "Last captured video URL", `/${this.adapter.namespace}/${station.getSerial()}/${DataLocation.LAST_EVENT}/${device.getSerial()}${STREAM_FILE_NAME_EXT}`, undefined, "url");
                            if (fse.pathExistsSync(`${filename_without_ext}${STREAM_FILE_NAME_EXT}`))
                                ffmpegPreviewImage(this.adapter.config, `${filename_without_ext}${STREAM_FILE_NAME_EXT}`, `${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`, this.log)
                                    .then(() => {
                                        setStateWithTimestamp(this.adapter, device.getStateID(CameraStateID.LAST_EVENT_PICTURE_URL), "Last event picture URL", `/${this.adapter.namespace}/${station.getSerial()}/${DataLocation.LAST_EVENT}/${device.getSerial()}${IMAGE_FILE_JPEG_EXT}`, undefined, "url");
                                        try {
                                            if (fse.existsSync(`${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`)) {
                                                const image_data = getImageAsHTML(fse.readFileSync(`${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`));
                                                setStateWithTimestamp(this.adapter, device.getStateID(CameraStateID.LAST_EVENT_PICTURE_HTML), "Last event picture HTML image", image_data, undefined, "html");
                                            }
                                        } catch (error) {
                                            this.log.error(`Station: ${station.getSerial()} device: ${device.getSerial()} - Error:`, error);
                                        }
                                    })
                                    .catch((error) => {
                                        this.log.error(`ffmpegPreviewImage - station: ${station.getSerial()} device: ${device.getSerial()} - Error:`, error);
                                    });
                        }
                    })
                    .catch((error) => {
                        this.log.error(`Station: ${station.getSerial()} channel: ${channel} - Error: ${error} - Cancelling download...`);
                        station.cancelDownload(device);
                    });
            } catch(error) {
                this.log.error(`Station: ${station.getSerial()} channel: ${channel} - Error: ${error} - Cancelling download...`);
                station.cancelDownload(device);
            }
        } catch(error) {
            this.log.error(`Station: ${station.getSerial()} channel: ${channel} - Error: ${error} - ffmpeg conversion couldn't start. HLS Stream not available.`);
        }
    }

    private onStopLivestream(station: Station, channel: number): void {
        this.log.trace(`Station: ${station.getSerial()} channel: ${channel}`);
        try {
            const device = this.getStationDevice(station.getSerial(), channel);
            this.emit("livestream stop", station, device);
        } catch(error) {
            this.log.error(`Station: ${station.getSerial()} channel: ${channel} - Error: ${error}`);
        }
    }

    private async onStartLivestream(station: Station, channel: number, metadata: StreamMetadata, videostream: Readable, audiostream: Readable): Promise<void> {
        this.log.trace(`Station: ${station.getSerial()} channel: ${channel}`);
        try {
            const device = this.getStationDevice(station.getSerial(), channel);
            try {
                const file_path = getDataFilePath(this.adapter, station.getSerial(), DataLocation.LIVESTREAM, `${device.getSerial()}${STREAM_FILE_NAME_EXT}`);
                await removeFiles(this.adapter, station.getSerial(), DataLocation.LIVESTREAM, device.getSerial()).catch();
                ffmpegStreamToHls(this.adapter.config, this.adapter.namespace, metadata, videostream, audiostream, file_path, this.log)
                    .then(() => {
                        if (fse.pathExistsSync(file_path)) {
                            removeFiles(this.adapter, station.getSerial(), DataLocation.LAST_LIVESTREAM, device.getSerial());
                            return true;
                        }
                        return false;
                    })
                    .then((result) => {
                        if (result)
                            moveFiles(this.adapter, station.getSerial(), device.getSerial(), DataLocation.LIVESTREAM, DataLocation.LAST_LIVESTREAM);
                        return result;
                    })
                    .then((result) => {
                        if (result) {
                            const filename_without_ext = getDataFilePath(this.adapter, station.getSerial(), DataLocation.LAST_LIVESTREAM, device.getSerial());
                            this.adapter.setStateAsync(device.getStateID(CameraStateID.LAST_LIVESTREAM_VIDEO_URL), { val: `/${this.adapter.namespace}/${station.getSerial()}/${DataLocation.LAST_LIVESTREAM}/${device.getSerial()}${STREAM_FILE_NAME_EXT}`, ack: true });
                            if (fse.pathExistsSync(`${filename_without_ext}${STREAM_FILE_NAME_EXT}`))
                                ffmpegPreviewImage(this.adapter.config, `${filename_without_ext}${STREAM_FILE_NAME_EXT}`, `${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`, this.log)
                                    .then(() => {
                                        this.adapter.setStateAsync(device.getStateID(CameraStateID.LAST_LIVESTREAM_PIC_URL), { val: `/${this.adapter.namespace}/${station.getSerial()}/${DataLocation.LAST_LIVESTREAM}/${device.getSerial()}${IMAGE_FILE_JPEG_EXT}`, ack: true });
                                        try {
                                            if (fse.existsSync(`${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`)) {
                                                this.adapter.setStateAsync(device.getStateID(CameraStateID.LAST_LIVESTREAM_PIC_HTML), { val: getImageAsHTML(fse.readFileSync(`${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`)), ack: true });
                                            }
                                        } catch (error) {
                                            this.log.error(`Station: ${station.getSerial()} device: ${device.getSerial()} - Error:`, error);
                                        }
                                    })
                                    .catch((error) => {
                                        this.log.error(`ffmpegPreviewImage - station: ${station.getSerial()} device: ${device.getSerial()} - Error:`, error);
                                    });
                        }
                    })
                    .catch((error) => {
                        this.log.error(`Station: ${station.getSerial()} channel: ${channel} - Error: ${error} - Stopping livestream...`);
                        station.stopLivestream(device);
                    });
                this.emit("livestream start", station, device, `/${this.adapter.namespace}/${station.getSerial()}/${DataLocation.LIVESTREAM}/${device.getSerial()}${STREAM_FILE_NAME_EXT}`);
            } catch(error) {
                this.log.error(`Station: ${station.getSerial()} channel: ${channel} - Error: ${error} - Stopping livestream...`);
                station.stopLivestream(device);
            }
        } catch(error) {
            this.log.error(`Station: ${station.getSerial()} channel: ${channel} - Error: ${error} - ffmpeg conversion couldn't start. HLS Stream not available.`);
        }
    }

    public async startLivestream(device_sn: string): Promise<void> {
        if (Object.keys(this.devices).includes(device_sn) && this.devices[device_sn].isCamera()) {
            const camera = this.devices[device_sn] as Camera;
            const station = this.stations[camera.getStationSerial()];

            if (station.isConnected()) {
                if (!station.isLiveStreaming(camera)) {
                    station.startLivestream(camera);

                    this.camera_livestream_timeout.set(device_sn, setTimeout(() => {
                        this.stopLivestream(device_sn);
                    }, this.camera_max_livestream_seconds * 1000));
                } else {
                    this.log.warn(`The stream for the device ${device_sn} cannot be started, because it is already streaming!`);
                }
            } else {
                if (!camera.isStreaming()) {
                    this._startRtmpLivestream(station, camera);
                } else {
                    this.log.warn(`The stream for the device ${device_sn} cannot be started, because it is already streaming!`);
                }
            }
        } else {
            throw new Error(`No camera device with this serial number: ${device_sn}!`);
        }
    }

    private async _startRtmpLivestream(station: Station, camera: Camera): Promise<void> {
        const url = await camera.startStream();
        if (url !== "") {
            const file_path = getDataFilePath(this.adapter, station.getSerial(), DataLocation.LIVESTREAM, `${camera.getSerial()}${STREAM_FILE_NAME_EXT}`);
            await sleep(2000);
            const rtmpPromise: StoppablePromise = ffmpegRTMPToHls(this.adapter.config, url, file_path, this.log);
            rtmpPromise.then(() => {
                if (fse.pathExistsSync(file_path)) {
                    removeFiles(this.adapter, station.getSerial(), DataLocation.LAST_LIVESTREAM, camera.getSerial());
                    return true;
                }
                return false;
            })
                .then((result) => {
                    if (result)
                        moveFiles(this.adapter, station.getSerial(), camera.getSerial(), DataLocation.LIVESTREAM, DataLocation.LAST_LIVESTREAM);
                    return result;
                })
                .then((result) => {
                    if (result) {
                        const filename_without_ext = getDataFilePath(this.adapter, station.getSerial(), DataLocation.LAST_LIVESTREAM, camera.getSerial());
                        if (fse.pathExistsSync(`${filename_without_ext}${STREAM_FILE_NAME_EXT}`))
                            ffmpegPreviewImage(this.adapter.config, `${filename_without_ext}${STREAM_FILE_NAME_EXT}`, `${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`, this.log, 5.5)
                                .then(() => {
                                    this.adapter.setStateAsync(camera.getStateID(CameraStateID.LAST_LIVESTREAM_PIC_URL), { val: `/${this.adapter.namespace}/${station.getSerial()}/${DataLocation.LAST_LIVESTREAM}/${camera.getSerial()}${IMAGE_FILE_JPEG_EXT}`, ack: true });
                                    try {
                                        if (fse.existsSync(`${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`)) {
                                            this.adapter.setStateAsync(camera.getStateID(CameraStateID.LAST_LIVESTREAM_PIC_HTML), { val: getImageAsHTML(fse.readFileSync(`${filename_without_ext}${IMAGE_FILE_JPEG_EXT}`)), ack: true });
                                        }
                                    } catch (error) {
                                        this.log.error(`Station: ${station.getSerial()} device: ${camera.getSerial()} - Error:`, error);
                                    }
                                })
                                .catch((error) => {
                                    this.log.error(`ffmpegPreviewImage - station: ${station.getSerial()} device: ${camera.getSerial()} - Error:`, error);
                                });
                    }
                })
                .catch((error) => {
                    this.log.error(`Station: ${station.getSerial()} device: ${camera.getSerial()} - Error: ${error} - Stopping livestream...`);
                    camera.stopStream();
                    this.emit("livestream stop", station, camera);
                });
            this.rtmpFFmpegPromise.set(camera.getSerial(), rtmpPromise);
            this.emit("livestream start", station, camera, `/${this.adapter.namespace}/${station.getSerial()}/${DataLocation.LIVESTREAM}/${camera.getSerial()}${STREAM_FILE_NAME_EXT}`);
            this.camera_livestream_timeout.set(camera.getSerial(), setTimeout(() => {
                this.stopLivestream(camera.getSerial());
            }, this.camera_max_livestream_seconds * 1000));
        }
    }

    public async stopLivestream(device_sn: string): Promise<void> {
        if (Object.keys(this.devices).includes(device_sn) && this.devices[device_sn].isCamera()) {
            const camera = this.devices[device_sn] as Camera;
            const station = this.stations[camera.getStationSerial()];

            if (station.isConnected() && station.isLiveStreaming(camera)) {
                await station.stopLivestream(camera);
            } else if (camera.isStreaming()) {
                await camera.stopStream();
                const rtmpPromise = this.rtmpFFmpegPromise.get(camera.getSerial());
                if (rtmpPromise) {
                    rtmpPromise.stop();
                    this.rtmpFFmpegPromise.delete(camera.getSerial());
                }
                this.emit("livestream stop", station, camera);
            } else {
                this.log.warn(`The stream for the device ${device_sn} cannot be stopped, because it isn't streaming!`);
            }

            const timeout = this.camera_livestream_timeout.get(device_sn);
            if (timeout) {
                clearTimeout(timeout);
                this.camera_livestream_timeout.delete(device_sn);
            }
        } else {
            this.log.warn(`Stream couldn't be stopped as no camera device with serial number ${device_sn} was found!`);
        }
    }

    private onRTSPUrl(station: Station, channel: number, rtsp_url: string, modified: number): void {
        this.log.trace(`Station: ${station.getSerial()} channel: ${channel} rtsp_url: ${rtsp_url}`);
        try {
            const device = this.getStationDevice(station.getSerial(), channel);
            setStateChangedWithTimestamp(this.adapter, device.getStateID(CameraStateID.RTSP_STREAM_URL), rtsp_url, modified);
        } catch (error) {
            this.log.error(`Station: ${station.getSerial()} channel: ${channel} - Error: ${error}`);
        }
    }

    public isConnected(): boolean {
        return this.connected;
    }

}