# Mercado Inteligente

Controle de despensa da família. React + Vite + Tailwind + Firebase.

Projeto simplificado: quase todo o código do app fica em `src/App.jsx`
(um arquivo só). Para editar qualquer funcionalidade ou visual, é esse
o arquivo a mudar. `src/firebase.js` guarda as credenciais e raramente
precisa ser tocado depois de configurado uma vez.

As fotos dos produtos ficam salvas direto no Firestore (miniatura e
versão ampliada), sem precisar do Firebase Storage — só o Firestore
Database é necessário.
