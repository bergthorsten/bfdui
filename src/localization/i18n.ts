import i18n from "i18next";
import { initReactI18next } from "react-i18next";

i18n.use(initReactI18next).init({
  fallbackLng: "en",
  resources: {
    en: {
      translation: {
        appName: "BFD",
        titleHomePage: "Dashboard",
        titleSecondPage: "Dev Systems",
        documentation: "Documentation",
        madeBy: "Made by Bergfreunde",
      },
    },
    "pt-BR": {
      translation: {
        appName: "BFD",
        titleHomePage: "Página Inicial",
        titleSecondPage: "Segunda Página",
        documentation: "Documentação",
        madeBy: "Feito pela Bergfreunde",
      },
    },
  },
});
