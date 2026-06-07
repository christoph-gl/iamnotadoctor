export type BikeSample = {
  timestamp: number;
  speedKph?: number;
  cadenceRpm?: number;
  powerW?: number;
  resistance?: number;
  heartRateBpm?: number;
};

const FTMS_SERVICE = 0x1826;
const INDOOR_BIKE_DATA = 0x2ad2;
const CONTROL_POINT = 0x2ad9;

export class TrainerClient {
  private device?: BluetoothDevice;
  private server?: BluetoothRemoteGATTServer;
  private control?: BluetoothRemoteGATTCharacteristic;
  private bikeData?: BluetoothRemoteGATTCharacteristic;

  public samples: BikeSample[] = [];
  public currentHeartRate?: number;

  get isConnected() {
    return this.device?.gatt?.connected ?? false;
  }

  async connect(onSample: (sample: BikeSample) => void, onDisconnect?: () => void) {
    if (!navigator.bluetooth) {
      throw new Error("Web Bluetooth is not supported in this browser.");
    }

    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS_SERVICE] }],
    });

    this.device.addEventListener("gattserverdisconnected", () => {
      console.log("Device disconnected");
      if (onDisconnect) onDisconnect();
    });

    this.server = await this.device.gatt!.connect();
    let service: BluetoothRemoteGATTService;
    try {
      service = await this.server.getPrimaryService(FTMS_SERVICE);
    } catch {
      this.device.gatt?.disconnect();
      throw new Error(
        `Selected device "${this.device.name || "Unknown device"}" does not expose the FTMS trainer service. Choose your smart trainer from the Bluetooth picker.`
      );
    }

    this.bikeData = await service.getCharacteristic(INDOOR_BIKE_DATA);
    this.control = await service.getCharacteristic(CONTROL_POINT);

    await this.control.startNotifications();
    this.control.addEventListener("characteristicvaluechanged", (event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value!;
      console.log("FTMS control response:", [...new Uint8Array(value.buffer)]);
    });

    await this.bikeData.startNotifications();
    this.bikeData.addEventListener("characteristicvaluechanged", (event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value!;
      const sample = parseIndoorBikeData(value);
      
      // Inject external HR if the trainer didn't provide one natively
      if (this.currentHeartRate !== undefined && sample.heartRateBpm === undefined) {
        sample.heartRateBpm = this.currentHeartRate;
      }
      
      this.samples.push(sample);
      onSample(sample);
    });

    await this.requestControl();
    await this.reset();
  }

  async disconnect() {
    this.device?.gatt?.disconnect();
  }

  private async writeControl(bytes: number[]) {
    if (!this.control) throw new Error("Not connected");
    await this.control.writeValueWithResponse(new Uint8Array(bytes));
  }

  async requestControl() {
    // FTMS opcode 0x00
    await this.writeControl([0x00]);
  }

  async reset() {
    // FTMS opcode 0x01
    await this.writeControl([0x01]);
  }

  async start() {
    // FTMS opcode 0x07
    await this.writeControl([0x07]);
  }

  async stop() {
    // FTMS opcode 0x08, parameter 0x01 = stop
    await this.writeControl([0x08, 0x01]);
  }

  async setResistance(level: number) {
    // FTMS opcode 0x04 = Set Target Resistance Level.
    // The FTMS spec defines resolution as 0.1 (so 100% = 1000).
    // Some trainers use a direct 0-100 scale (100% = 100).
    const raw = Math.round(level);
    const buffer = new ArrayBuffer(3);
    const view = new DataView(buffer);

    view.setUint8(0, 0x04);
    view.setInt16(1, raw, true);

    await this.writeControl([...new Uint8Array(buffer)]);
  }

  async setTargetPower(watts: number) {
    // FTMS opcode 0x05 = Set Target Power.
    // ERG-style mode: trainer adjusts resistance to maintain watts.
    const buffer = new ArrayBuffer(3);
    const view = new DataView(buffer);

    view.setUint8(0, 0x05);
    view.setInt16(1, Math.round(watts), true);

    await this.writeControl([...new Uint8Array(buffer)]);
  }
}

function parseIndoorBikeData(data: DataView): BikeSample {
  const flags = data.getUint16(0, true);
  let offset = 2;

  const sample: BikeSample = {
    timestamp: Date.now(),
  };

  // Bit 0 is "More Data".
  // If bit 0 is NOT set, instantaneous speed is present.
  const moreData = (flags & 0x0001) !== 0;

  if (!moreData) {
    sample.speedKph = data.getUint16(offset, true) / 100;
    offset += 2;
  }

  if (flags & 0x0002) {
    // Average speed
    offset += 2;
  }

  if (flags & 0x0004) {
    // Instantaneous cadence, unit = 0.5 rpm
    sample.cadenceRpm = data.getUint16(offset, true) / 2;
    offset += 2;
  }

  if (flags & 0x0008) {
    // Average cadence
    offset += 2;
  }

  if (flags & 0x0010) {
    // Total distance, uint24 meters
    offset += 3;
  }

  if (flags & 0x0020) {
    // Resistance level, sint16
    sample.resistance = data.getInt16(offset, true);
    offset += 2;
  }

  if (flags & 0x0040) {
    // Instantaneous power, watts
    sample.powerW = data.getInt16(offset, true);
    offset += 2;
  }

  if (flags & 0x0080) {
    // Average power
    offset += 2;
  }

  if (flags & 0x0100) {
    // Expended energy block:
    // total energy uint16, energy/hour uint16, energy/min uint8
    offset += 5;
  }

  if (flags & 0x0200) {
    // Heart rate
    sample.heartRateBpm = data.getUint8(offset);
    offset += 1;
  }

  if (flags & 0x0400) {
    // MET
    offset += 1;
  }

  if (flags & 0x0800) {
    // Elapsed time
    offset += 2;
  }

  if (flags & 0x1000) {
    // Remaining time
    offset += 2;
  }

  return sample;
}
