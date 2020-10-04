export enum DeviceType {
    //List retrieved from com.oceanwing.battery.cam.binder.model.QueryDeviceData
    BATTERY_DOORBELL = 7,
    CAMERA = 1,
    CAMERA2 = 9,
    CAMERA2C = 8,
    CAMERA_E = 4,
    DOORBELL = 5,
    FLOODLIGHT = 3,
    INDOOR_CAMERA = 30,
    INDOOR_PT_CAMERA = 31,
    KEYPAD = 11,
    LOCK_ADVANCED = 51,
    LOCK_BASIC = 50,
    LOCK_SIMPLE = 52,
    MOTION_SENSOR = 10,
    SENSOR = 2,
    STATION = 0
}

export enum ParamType {
    //List retrieved from com.oceanwing.battery.cam.binder.model.CameraParams
    CHIME_STATE = 2015,
    DETECT_EXPOSURE = 2023,
    DETECT_MODE = 2004,
    DETECT_MOTION_SENSITIVE = 2005,
    DETECT_SCENARIO = 2028,
    DETECT_SWITCH = 2027,
    DETECT_ZONE = 2006,
    DOORBELL_AUDIO_RECODE = 2042,
    DOORBELL_BRIGHTNESS = 2032,
    DOORBELL_DISTORTION = 2033,
    DOORBELL_HDR = 2029,
    DOORBELL_IR_MODE = 2030,
    DOORBELL_LED_NIGHT_MODE = 2039,
    DOORBELL_MOTION_ADVANCE_OPTION = 2041,
    DOORBELL_MOTION_NOTIFICATION = 2035,
    DOORBELL_NOTIFICATION_JUMP_MODE = 2038,
    DOORBELL_NOTIFICATION_OPEN = 2036,
    DOORBELL_RECORD_QUALITY = 2034,
    DOORBELL_RING_RECORD = 2040,
    DOORBELL_SNOOZE_START_TIME = 2037,
    DOORBELL_VIDEO_QUALITY = 2031,
    NIGHT_VISUAL = 2002,
    OPEN_DEVICE = 2001,
    RINGING_VOLUME = 2022,
    SDCARD = 2010,
    UN_DETECT_ZONE = 2007,
    VOLUME = 2003,

    // Inferred from source
    SNOOZE_MODE = 1271,  // The value is base64 encoded
    WATERMARK_MODE = 1214,  // 1 - hide, 2 - show
    DEVICE_UPGRADE_NOW = 1134,
    CAMERA_UPGRADE_NOW = 1133,
    SCHEDULE_MODE = 1257,
    GUARD_MODE = 1224,  // 0 - Away, 1 - Home, 63 - Disarmed, 2 - Schedule

    FLOODLIGHT_MANUAL_SWITCH = 1400,
    FLOODLIGHT_MANUAL_BRIGHTNESS = 1401,  // The range is 22-100
    FLOODLIGHT_MOTION_BRIGHTNESS = 1412,  // The range is 22-100
    FLOODLIGHT_SCHEDULE_BRIGHTNESS = 1413,  // The range is 22-100
    FLOODLIGHT_MOTION_SENSITIVTY = 1272,  // The range is 1-5

    CAMERA_SPEAKER_VOLUME = 1230,
    CAMERA_RECORD_ENABLE_AUDIO = 1366,  // Enable microphone
    CAMERA_RECORD_RETRIGGER_INTERVAL = 1250,  // In seconds
    CAMERA_RECORD_CLIP_LENGTH = 1249,  // In seconds

    CAMERA_IR_CUT = 1013,
    CAMERA_PIR = 1011,
    CAMERA_WIFI_RSSI = 1142,

    CAMERA_MOTION_ZONES = 1204,

    // Set only params?
    PUSH_MSG_MODE = 1252,  // 0 to ???
}

export enum GuardMode {
    AWAY = 0,
    HOME = 1,
    DISARMED = 63,
    SCHEDULE = 2
}

export const DeviceStateID = {
    NAME: "name",
    MODEL: "model",
    SERIAL_NUMBER: "serial_number",
    HARDWARE_VERSION: "hardware_version",
    SOFTWARE_VERSION: "software_version",
}

export const CameraStateID = {
    ...DeviceStateID,
    MAC_ADDRESS: "mac_address",
    LAST_CAMERA_URL: "last_camera_url",
    LIVESTREAM: "livestream",
    START_STREAM: "start_stream",
    STOP_STREAM: "stop_stream"
}

export const StationStateID = {
    ...DeviceStateID,
    GUARD_MODE: "guard_mode",
    IP_ADDRESS: "ip_address",
    MAC_ADDRESS: "mac_address",
}