import { Device, Devices, Station, Stations, Credentials, PushMessage } from "eufy-security-client";

export interface EufySecurityEvents {
    "devices": (devices: Devices) => void;
    "stations": (stations: Stations) => void;
    "push message": (message: PushMessage) => void;
    "push connect": () => void;
    "push close": () => void;
    "connect": () => void;
    "close": () => void;
    "device parameter": (device: Device, param_type: number, param_value: string) => void;
    "station parameter": (station: Station, param_type: number, param_value: string) => void;
    "livestream start": (station: Station, device: Device, url: string) => void;
    "livestream stop": (station: Station, device: Device) => void;
}

export interface AdapterConfig {
    username: string;
    password: string;
    pollingInterval: number;
    maxLivestreamDuration: number;
    eventDuration: number;
    verificationMethod: number;
    p2pConnectionType: string;
}

export interface PersistentData {
    login_hash: string;
    openudid: string;
    serial_number: string;
    api_base: string;
    cloud_token: string;
    cloud_token_expiration: number;
    push_credentials: Credentials | undefined;
    push_persistentIds: string[];
    version: string;
}


export interface ImageResponse {
    status: number;
    statusText: string;
    imageUrl: string;
    imageHtml: string;
}

export interface IStoppablePromise<T> extends Promise<T> {
    stop: () => void;
}