# GenieACS Simulator — Device Profiles

Place device profile scripts here to simulate CPEs.

## Usage

```bash
# Spawn a single simulated device
docker compose --profile sim run genieacs-sim genieacs-sim --acs http://genieacs:7547/ --serial CUSTOM-SN-123

# Spawn multiple sims in background
docker compose --profile sim up -d --scale genieacs-sim=5 genieacs-sim
```

## Custom Profiles

Create `.js` files to define CPE data models. Mounted at `/opt/genieacs-sim/`.

Example: `huawei-hg.js`
```js
module.exports = {
  // ...
};
```

Then pass it to the sim:
```bash
genieacs-sim --acs http://genieacs:7547/ --profile /opt/genieacs-sim/huawei-hg.js
```
