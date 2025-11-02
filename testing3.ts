import noble, { Peripheral, Characteristic, Service } from "@abandonware/noble";

const TARGET_SERVICE = "6e400001b5a3f393e0a9e50e24dcca9e"; // как и раньше
const STX = Buffer.from([0xa3, 0xa4]);
// ⚠️ замени, если знаешь настоящий ключ
const DEVICE_KEY = Buffer.from("796F546D4B35307A", "hex");

function crc8(data: Buffer, poly = 0x07, init = 0x00): number {
  let crc = init;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x80) crc = ((crc << 1) & 0xff) ^ poly;
      else crc = (crc << 1) & 0xff;
    }
  }
  return crc & 0xff;
}

// вариант из PDF: STX + LEN + BODY + CRC, XOR по (RAND+0x32)
function buildFrame_STX(cmd: number, data: Buffer, key?: Buffer): Buffer {
  const keyField = key ?? Buffer.alloc(8, 0x00);
  const rand = Math.floor(Math.random() * 256);
  const xorVal = (rand + 0x32) & 0xff;
  const randBuf = Buffer.from([rand]);
  const encData = Buffer.from(data.map((b) => b ^ xorVal));
  const body = Buffer.concat([randBuf, keyField, Buffer.from([cmd]), encData]);
  const len = Buffer.from([body.length + 1]);
  const crc = Buffer.from([crc8(Buffer.concat([len, body]))]);
  return Buffer.concat([STX, len, body, crc]);
}

// «облегчённый» вариант: БЕЗ STX, иногда так делают в BLE
function buildFrame_NO_STX(cmd: number, data: Buffer, key?: Buffer): Buffer {
  const keyField = key ?? Buffer.alloc(8, 0x00);
  const rand = Math.floor(Math.random() * 256);
  const xorVal = (rand + 0x32) & 0xff;
  const randBuf = Buffer.from([rand]);
  const encData = Buffer.from(data.map((b) => b ^ xorVal));
  const body = Buffer.concat([randBuf, keyField, Buffer.from([cmd]), encData]);
  const len = Buffer.from([body.length + 1]);
  const crc = Buffer.from([crc8(Buffer.concat([len, body]))]);
  return Buffer.concat([len, body, crc]);
}

async function dumpGatt(peripheral: Peripheral) {
  const services: Service[] = await peripheral.discoverServicesAsync([]);
  console.log("📜 Сервисы:");
  for (const s of services) {
    console.log(`  - ${s.uuid}`);
    const chars: Characteristic[] = await s.discoverCharacteristicsAsync([]);
    for (const c of chars) {
      console.log(
        `      • ${c.uuid} props=${JSON.stringify(c.properties)}`
      );
    }
  }
}

async function main() {
  console.log("🔎 Сканирую...");
  noble.on("stateChange", async (state) => {
    if (state === "poweredOn") {
      await noble.startScanningAsync([], false); // сканим всё, не только по сервису
    }
  });

  noble.on("discover", async (peripheral: Peripheral) => {
    const name = peripheral.advertisement.localName || "?";
    // фильтр по имени, чтобы не цеплять всё подряд
    if (!name.toLowerCase().includes("scooter")) return;

    console.log(`\n🚲 Найдено: ${name} (${peripheral.address || "no-mac"})`);
    await noble.stopScanningAsync();

    await peripheral.connectAsync();
    console.log("✅ Подключились, читаем GATT...");
    await dumpGatt(peripheral);

    const { characteristics } =
      await peripheral.discoverSomeServicesAndCharacteristicsAsync([], []);

    // подписываемся на все notify/indicate
    const notifyChars: Characteristic[] = [];
    for (const ch of characteristics) {
      if (ch.properties.includes("notify") || ch.properties.includes("indicate")) {
        notifyChars.push(ch);
        ch.on("data", (data, isNotify) => {
          console.log(
            `📩 notify from ${ch.uuid}: ${data.toString("hex")}`
          );
        });
        await ch.subscribeAsync().catch(() => {});
      }
    }

    console.log(`🔔 Подписались на ${notifyChars.length} характеристик`);

    // все write/ writeWithoutResponse кандидаты
    const writeChars = characteristics.filter((ch) =>
      ch.properties.some((p) => p === "write" || p === "writeWithoutResponse")
    );

    console.log(`📝 Будем писать в ${writeChars.length} характеристик`);

    // 4 варианта фрейма
    const frames = [
      { desc: "STX cmd=0x01", buf: buildFrame_STX(0x01, DEVICE_KEY) },
      { desc: "STX cmd=0x10", buf: buildFrame_STX(0x10, DEVICE_KEY) },
      { desc: "noSTX cmd=0x01", buf: buildFrame_NO_STX(0x01, DEVICE_KEY) },
      { desc: "noSTX cmd=0x10", buf: buildFrame_NO_STX(0x10, DEVICE_KEY) },
    ];

    for (const ch of writeChars) {
      console.log(`\n➡️  Пишем в характеристику ${ch.uuid} ...`);
      for (const fr of frames) {
        console.log(`   → ${fr.desc}: ${fr.buf.toString("hex")}`);
        try {
          await ch.writeAsync(fr.buf, true).catch(() => ch.writeAsync(fr.buf, false));
        } catch (e) {
          console.log("     (write error)", e);
        }
        // дать устройству шанс ответить
        await new Promise((r) => setTimeout(r, 800));
      }
    }

    console.log("⏳ Ждём ответы 30 сек...");
    await new Promise((r) => setTimeout(r, 30000));

    // отписаться и уйти
    for (const ch of notifyChars) {
      await ch.unsubscribeAsync().catch(() => {});
    }
    await peripheral.disconnectAsync().catch(() => {});
    console.log("🏁 Готово.");
    process.exit(0);
  });
}

main().catch((e) => console.error(e));
