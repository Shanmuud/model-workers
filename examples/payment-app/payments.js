// A small fictional app for trying model-workers without sharing private code.
export async function pay(charge, sleep) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await charge();
    } catch (error) {
      if (error.code !== 'NETWORK_ERROR' || attempt === 2) throw error;
      await sleep(5000);
    }
  }
}
