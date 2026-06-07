export const HEART_RATE_SERVICE = 0x180d;
export const HEART_RATE_MEASUREMENT = 0x2a37;

export class HeartRateClient {
  private device?: BluetoothDevice;
  private server?: BluetoothRemoteGATTServer;
  private measurement?: BluetoothRemoteGATTCharacteristic;

  get isConnected() {
    return this.device?.gatt?.connected ?? false;
  }

  async connect(onHeartRate: (bpm: number) => void, onDisconnect?: () => void) {
    if (!navigator.bluetooth) {
      throw new Error("Web Bluetooth is not supported in this browser.");
    }

    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HEART_RATE_SERVICE] }],
    });

    this.device.addEventListener("gattserverdisconnected", () => {
      console.log("HRM disconnected");
      if (onDisconnect) onDisconnect();
    });

    this.server = await this.device.gatt!.connect();
    let service: BluetoothRemoteGATTService;
    try {
      service = await this.server.getPrimaryService(HEART_RATE_SERVICE);
    } catch {
      this.device.gatt?.disconnect();
      throw new Error(
        `Selected device "${this.device.name || "Unknown device"}" does not expose the Heart Rate service. Choose your HRM from the Bluetooth picker.`
      );
    }
    this.measurement = await service.getCharacteristic(HEART_RATE_MEASUREMENT);

    await this.measurement.startNotifications();
    this.measurement.addEventListener("characteristicvaluechanged", (event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value!;
      const bpm = this.parseHeartRate(value);
      onHeartRate(bpm);
    });
  }

  async disconnect() {
    this.device?.gatt?.disconnect();
  }

  private parseHeartRate(value: DataView): number {
    const flags = value.getUint8(0);
    const rate16Bits = flags & 0x01;
    if (rate16Bits) {
      return value.getUint16(1, true);
    } else {
      return value.getUint8(1);
    }
  }
}
