const themeSettingKeys = Object.freeze(['primaryColor', 'fontSize', 'lineHeight', 'blockSpacing']);
const themeSettingDefaults = Object.freeze({ primaryColor: '#0F4C81', fontSize: '16px', lineHeight: '1.75', blockSpacing: '1' });
const themeSettingOptions = Object.freeze({
  primaryColor: Object.freeze(['#0F4C81', '#009874', '#FA5151', '#FECE00', '#92617E', '#55C9EA', '#B76E79', '#556B2F', '#333333', '#A9A9A9', '#FFB7C5']),
  fontSize: Object.freeze(['14px', '15px', '16px', '17px', '18px']),
  lineHeight: Object.freeze(['1.5', '1.65', '1.75', '1.9', '2.05']),
  blockSpacing: Object.freeze(['0.75', '0.9', '1', '1.15', '1.35'])
});

export const typesettingThemeNames = Object.freeze(['default', 'grace', 'simple']);

const hasOwn = (value, key) => typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, key);
const hasExactKeys = (value, keys) => typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => hasOwn(value, key));

function invalidPresentation(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

export function createDefaultThemeSettings() {
  return Object.fromEntries(typesettingThemeNames.map(theme => [theme, { ...themeSettingDefaults }]));
}

export function normalizeTypesettingTheme(theme) {
  if (!typesettingThemeNames.includes(theme)) return invalidPresentation('排版主题无效');
  return theme;
}

function normalizeThemeSettings(settings) {
  if (!hasExactKeys(settings, themeSettingKeys)) return invalidPresentation('排版主题设置无效');
  const normalized = {};
  for (const key of themeSettingKeys) {
    if (!themeSettingOptions[key].includes(settings[key])) return invalidPresentation('排版主题设置无效');
    normalized[key] = settings[key];
  }
  return normalized;
}

export function normalizeTypesettingThemeSettings(settings) {
  if (!hasExactKeys(settings, typesettingThemeNames)) return invalidPresentation('排版主题设置无效');
  return Object.fromEntries(typesettingThemeNames.map(theme => [theme, normalizeThemeSettings(settings[theme])]));
}

export function normalizeTypesettingPresentation(value) {
  if (!hasExactKeys(value, ['theme', 'settings'])) return invalidPresentation('排版主题配置无效');
  return { theme: normalizeTypesettingTheme(value.theme), settings: normalizeThemeSettings(value.settings) };
}

export function areTypesettingThemeSettingsEqual(left, right) {
  return typesettingThemeNames.every(theme => themeSettingKeys.every(key => left[theme][key] === right[theme][key]));
}
