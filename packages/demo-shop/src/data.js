// Seed data for ShopMax, the complex evaluation target.
// 120 products across 6 categories so the catalogue needs search, filtering,
// sorting, pagination and lazy loading rather than fitting on one screen.

const CATEGORIES = ['Computers', 'Accessories', 'Displays', 'Audio', 'Storage', 'Networking']

const NAMES = {
  Computers: ['Laptop Pro', 'Ultrabook Air', 'Workstation Tower', 'Mini PC', 'Gaming Rig'],
  Accessories: ['Wireless Mouse', 'Mechanical Keyboard', 'USB-C Hub', 'Laptop Stand', 'Webcam'],
  Displays: ['QHD Monitor', 'Ultrawide Display', '4K Monitor', 'Portable Screen', 'Touch Display'],
  Audio: ['Noise-Cancelling Headphones', 'Studio Monitors', 'USB Microphone', 'Earbuds', 'Soundbar'],
  Storage: ['NVMe SSD', 'Portable HDD', 'SD Card', 'NAS Enclosure', 'USB Flash Drive'],
  Networking: ['Wi-Fi 6 Router', 'Network Switch', 'Powerline Adapter', 'USB Ethernet', 'Mesh Node'],
}

/** Deterministic pseudo-random so the catalogue is identical on every reset. */
function rng(seed) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}

export function buildProducts() {
  const rand = rng(42)
  const products = []
  let id = 1
  for (const category of CATEGORIES) {
    const names = NAMES[category]
    for (let i = 0; i < 20; i++) {
      const base = names[i % names.length]
      const variant = ['', ' 14', ' 16', ' Plus', ' Mini', ' Pro', ' SE', ' XL', ' 2', ' Max'][i % 10]
      const name = `${base}${variant}`.trim()
      const price = Math.round((15 + rand() * 1400) * 100) / 100
      products.push({
        id: `p${id}`,
        sku: `SKU-${String(id).padStart(4, '0')}`,
        name: `${name} ${String.fromCharCode(65 + (i % 26))}${id}`,
        price,
        category,
        rating: Math.round((2.5 + rand() * 2.5) * 10) / 10,
        stock: Math.floor(rand() * 40),
        desc: `${name} in the ${category.toLowerCase()} range. Model ${id}, ships in 2–3 days.`,
      })
      id++
    }
  }
  return products
}

export const COUPONS = {
  SAVE10: { rate: 0.1, label: '10% off your order' },
  WELCOME5: { rate: 0.05, label: '5% off your first order' },
  FREESHIP: { rate: 0, label: 'Free shipping', freeShipping: true },
}

export const SHIPPING_FLAT = 9.99

export const SEED_USERS = [
  { id: 'u1', name: 'Test User', email: 'test@example.com', password: 'Password123!', role: 'customer' },
  { id: 'u2', name: 'Admin User', email: 'admin@example.com', password: 'Admin123!', role: 'admin' },
]

export { CATEGORIES }
