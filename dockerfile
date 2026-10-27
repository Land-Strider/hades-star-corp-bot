FROM node:20-alpine

WORKDIR /app

# Fonts for the RS scoreboard canvas renderer (Alpine ships none)
RUN apk add --no-cache font-dejavu font-noto-emoji

COPY package*.json ./
RUN npm install --production

COPY . .

CMD ["node", "src/index.js"]
