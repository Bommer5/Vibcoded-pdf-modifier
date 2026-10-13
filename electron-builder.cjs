// Configuration de l'empaquetage (electron-builder).
// Version : 0.1.<numéro du build de la CI>. Elle monte à chaque build, si bien qu'installer une
// nouvelle version par-dessus l'ancienne la met à jour (Windows : installateur ; Linux : le .deb
// est vu comme une mise à jour par apt / le gestionnaire de paquets).
const build = process.env.GITHUB_RUN_NUMBER
const version = build ? `0.1.${build}` : require('./package.json').version

const config = {
  "appId": "app.feuillet.editor",
  "productName": "Feuillet",
  "directories": {
    "buildResources": "build",
    "output": "release"
  },
  "files": [
    "out/**",
    "package.json",
    "!node_modules/**"
  ],
  "asar": true,
  "fileAssociations": [
    {
      "ext": "pdf",
      "name": "PDF",
      "mimeType": "application/pdf",
      "role": "Editor"
    },
    {
      "ext": "feuillet",
      "name": "Projet Feuillet",
      "mimeType": "application/x-feuillet",
      "role": "Editor"
    },
    {
      "ext": "xopp",
      "name": "Xournal++",
      "mimeType": "application/x-xopp",
      "role": "Editor"
    },
    {
      "ext": "xoj",
      "name": "Xournal",
      "mimeType": "application/x-xojpp",
      "role": "Editor"
    }
  ],
  "linux": {
    "target": [
      "AppImage",
      "deb"
    ],
    "fileAssociations": [
      {
        "ext": "pdf",
        "name": "PDF",
        "mimeType": "application/pdf",
        "role": "Editor"
      },
      {
        "ext": "feuillet",
        "name": "Projet Feuillet",
        "mimeType": "application/x-feuillet",
        "role": "Editor"
      },
      {
        "ext": "xopp",
        "name": "Xournal++",
        "mimeType": "application/x-xopp",
        "role": "Editor"
      },
      {
        "ext": "xoj",
        "name": "Xournal",
        "mimeType": "application/x-xojpp",
        "role": "Editor"
      },
      {
        "ext": "png",
        "name": "Image PNG",
        "mimeType": "image/png",
        "role": "Editor"
      },
      {
        "ext": "jpg",
        "name": "Image JPEG",
        "mimeType": "image/jpeg",
        "role": "Editor"
      },
      {
        "ext": "jpeg",
        "name": "Image JPEG",
        "mimeType": "image/jpeg",
        "role": "Editor"
      },
      {
        "ext": "webp",
        "name": "Image WebP",
        "mimeType": "image/webp",
        "role": "Editor"
      },
      {
        "ext": "gif",
        "name": "Image GIF",
        "mimeType": "image/gif",
        "role": "Editor"
      },
      {
        "ext": "bmp",
        "name": "Image BMP",
        "mimeType": "image/bmp",
        "role": "Editor"
      },
      {
        "ext": "tif",
        "name": "Image TIFF",
        "mimeType": "image/tiff",
        "role": "Editor"
      },
      {
        "ext": "tiff",
        "name": "Image TIFF",
        "mimeType": "image/tiff",
        "role": "Editor"
      },
      {
        "ext": "svg",
        "name": "Image SVG",
        "mimeType": "image/svg+xml",
        "role": "Editor"
      },
      {
        "ext": "docx",
        "name": "Document Word",
        "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "role": "Editor"
      },
      {
        "ext": "doc",
        "name": "Document Word",
        "mimeType": "application/msword",
        "role": "Editor"
      },
      {
        "ext": "odt",
        "name": "Document OpenDocument",
        "mimeType": "application/vnd.oasis.opendocument.text",
        "role": "Editor"
      },
      {
        "ext": "rtf",
        "name": "Document RTF",
        "mimeType": "application/rtf",
        "role": "Editor"
      },
      {
        "ext": "pptx",
        "name": "Présentation PowerPoint",
        "mimeType": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "role": "Editor"
      },
      {
        "ext": "odp",
        "name": "Présentation OpenDocument",
        "mimeType": "application/vnd.oasis.opendocument.presentation",
        "role": "Editor"
      }
    ],
    "category": "Graphics",
    "maintainer": "Feuillet <feuillet@users.noreply.github.com>",
    "synopsis": "Éditeur de PDF, documents et images pour tablettes graphiques",
    "desktop": {
      "entry": {
        "StartupWMClass": "Feuillet"
      }
    }
  },
  "extraResources": [
    {
      "from": "build/icon.png",
      "to": "icon.png"
    }
  ],
  "win": {
    "target": [
      "nsis",
      "portable"
    ]
  },
  "nsis": {
    "include": "build/installer.nsh",
    "oneClick": false,
    "allowToChangeInstallationDirectory": true
  }
}

module.exports = {
  ...config,
  extraMetadata: { version },
  buildVersion: version
}
