# ble_handshake.py
import asyncio
import os
import struct
import random
from bleak import BleakClient, BleakScanner

# --- Настройки / UUID из спецификации ---
SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
WRITE_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
NOTIFY_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

# STX = 0xA3 0xA4 (2 bytes) — согласно доку
STX = bytes([0xA3, 0xA4])

# Пример Device Key (если у тебя другой - укажи свой 8-байтный ключ)
# ВНИМАНИЕ: не оставляй дефолт в рабочей среде, уточни у оператора.
DEVICE_KEY_HEX = "796F546D4B35307A"  # ascii "yOTmK50z" в hex — пример из доки
DEVICE_KEY = bytes.fromhex(DEVICE_KEY_HEX)

# CRC8: простая реализация (poly=0x07) — если в Appendix другой полином, замени.
def crc8(data: bytes, poly=0x07, init=0x00) -> int:
    crc = init
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 0x80:
                crc = ((crc << 1) & 0xFF) ^ poly
            else:
                crc = (crc << 1) & 0xFF
    return crc & 0xFF

# Упаковка фрейма по формату:
# STX(2) | LEN(1) | RAND(1) | KEY(8) | CMD(1) | DATA(N) | CRC8(1)
def build_frame(cmd: int, data: bytes, key_field: bytes = None) -> bytes:
    if key_field is None:
        key_field = b"\x00" * 8
    # RAND — случайный байт
    rand = random.randrange(0, 256)
    rand_b = bytes([rand])
    # В доке: "insert RAND_1 = RAND + 0x32, XOR всех байт данных с RAND"
    # Реализуем: xor_val = rand (в доке упоминается RAND и RAND_1; если нужно использовать RAND_1, скорректируй)
    xor_val = rand & 0xFF
    # Шифруем DATA: каждый байт XOR xor_val
    encrypted_data = bytes([b ^ xor_val for b in data])
    # Составляем тело до CRC: RAND | KEY(8) | CMD | encrypted_data
    body = rand_b + key_field + bytes([cmd]) + encrypted_data
    # LEN — длина body + CRC (один байт CRC в конце)
    length = len(body) + 1  # +1 для CRC
    if length > 255:
        raise ValueError("Frame too long")
    len_b = bytes([length])
    # Полный пакет без CRC
    packet_no_crc = STX + len_b + body
    # CRC8 считается по спецификации: обычно по всем байтам после STX или по body — уточни в Appendix.
    # Здесь считаем CRC8 по body (RAND..DATA), поменяй если в appendix иная область.
    crc = crc8(body)
    crc_b = bytes([crc])
    frame = packet_no_crc + crc_b
    return frame

# Разбор ответа: проверка CRC и извлечение Communication KEY (в DATA)
def parse_response(response: bytes):
    # ожидаем: STX(2) | LEN | RAND | KEY(8?) | CMD | DATA | CRC
    if len(response) < 2 + 1 + 1 + 1:
        raise ValueError("Response too short")
    if response[0:2] != STX:
        raise ValueError("Bad STX")
    length = response[2]
    body = response[3:3+length-1]  # excluding CRC
    crc_recv = response[3+length-1]
    crc_calc = crc8(body)
    if crc_calc != crc_recv:
        raise ValueError(f"CRC mismatch: got {crc_recv:02X}, calc {crc_calc:02X}")
    # распарсим: RAND (1) | KEY(8) | CMD(1) | DATA ...
    rand = body[0]
    key_field = body[1:9]
    cmd = body[9]
    enc_data = body[10:]
    # расшифровываем DATA (XOR с RAND)
    data = bytes([b ^ rand for b in enc_data])
    return {
        "rand": rand,
        "key_field": key_field,
        "cmd": cmd,
        "data": data
    }

# Callback для уведомлений
resp_future = None
def notification_handler(sender, data):
    global resp_future
    print(f"[notify] from {sender}: {data.hex()}")
    # сохраним последний ответ
    if resp_future is not None and not resp_future.done():
        resp_future.set_result(data)

async def connect_and_get_comm_key(address: str, device_key: bytes):
    global resp_future
    async with BleakClient(address) as client:
        print("Connected:", await client.is_connected())
        # подписываемся на уведомления
        await client.start_notify(NOTIFY_CHAR_UUID, notification_handler)
        # строим фрейм 0x01 (Request Communication Key) — DATA = device_key (8 байт)
        frame = build_frame(cmd=0x01, data=device_key, key_field=b"\x00"*8)
        print("Send frame:", frame.hex())
        # подготовим future для ответа
        loop = asyncio.get_event_loop()
        resp_future = loop.create_future()
        # пишем (write-with-response)
        await client.write_gatt_char(WRITE_CHAR_UUID, frame, response=True)
        try:
            response = await asyncio.wait_for(resp_future, timeout=6.0)  # ожидание ответа
        except asyncio.TimeoutError:
            raise TimeoutError("No response from device after handshake")
        print("Raw response:", response.hex())
        parsed = parse_response(response)
        # В DATA должен быть Communication Key (обычно 8 байт) — вытаскиваем
        comm_key = parsed["data"]
        print("Parsed response:", parsed)
        print("Communication Key (hex):", comm_key.hex())
        await client.stop_notify(NOTIFY_CHAR_UUID)
        return comm_key

# Пример запуска
async def main():
    # Найти устройство (если не знаешь адрес) — можно пробежаться по скану
    print("Сканирую 8 секунд для нахождения устройств с нужным UUID...")
    devices = await BleakScanner.discover(timeout=8.0)
    target = None
    for d in devices:
        adv = d.metadata.get("uuids", []) if d.metadata else []
        if any(s.lower() == SERVICE_UUID.lower() for s in adv):
            target = d
            break
    if target is None:
        print("Не найдено устройство с целевым UUID. Укажи адрес вручную.")
        return
    print("Найдено:", target.address, target.name)
    comm_key = await connect_and_get_comm_key(target.address, DEVICE_KEY)
    print("Получен Communication Key:", comm_key.hex())

if __name__ == "__main__":
    asyncio.run(main())
