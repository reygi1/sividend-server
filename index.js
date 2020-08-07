const express = require("express");
const bodyParser = require("body-parser");
global.fetch = require("node-fetch");
var setCookie = require("set-cookie-parser");
const Twitter = require("twitter-lite");

const user = new Twitter({
  consumer_key: "SECRET",
  consumer_secret: "SECRET",
});

const twitterapp = new Twitter({
  bearer_token: "SECRET",
});

const language = require("@google-cloud/language");
const languageClient = new language.LanguageServiceClient();

let googleNewsAPI = require("./gnews");

const cors = require("cors");
const app = express();

app.use(bodyParser.json());

app.use(cors());
const port = process.env.PORT || 3000;

const mongoose = require("mongoose");

const url = "mongodb+srv://secret";

mongoose.connect(url, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const connection = mongoose.connection;

connection.once("open", function () {
  console.log("MongoDB database connection established successfully");
});

const Stocks = mongoose.model(
  "Stocks",
  mongoose.Schema({
    Name: String,
    Ticker: String,
  })
);

function getRequestCookie(cookies) {
  return cookies.reduce((result, current) => {
    if (result.length > 0) {
      result += "; ";
    }
    result += `${current.name}=${current.value}`;
    return result;
  }, "");
}

app.get("/history/:symbol", (req, res) => {
  console.log("called");

  (async () => {
    try {
      let symbol = req.params.symbol;

      symbol = symbol.replace(/\./g, "-");

      var options = {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.14; rv:75.0) Gecko/20100101 Firefox/75.0",
        },
      };

      var response = await fetch(
        `https://finance.yahoo.com/quote/${symbol}/history?p=${symbol}`,
        options
      );
      if (response.status !== 200) {
        throw new Error(`failed to fetch yahoo finance: ${response.status}`);
      }
      var cookieHeader = response.headers.get("set-cookie");
      var cookiesSet = setCookie.parse(
        setCookie.splitCookiesString(cookieHeader)
      );
      options.headers["Cookie"] = getRequestCookie(cookiesSet);

      var responseBody = await response.text();
      var crumbMatch = responseBody.match(/("CrumbStore":{[^}]+})/);
      var crumbObject = JSON.parse("{" + crumbMatch[1] + "}");

      let startEpoch = -2147483648;
      let endEpoch = Math.round(new Date().getTime() / 1000);

      let baseUrl = "https://query1.finance.yahoo.com/v7/finance/download/";
      var args = `${symbol}?period1=${startEpoch}&period2=${endEpoch}&interval=1d&events=history&crumb=${crumbObject.CrumbStore.crumb}`;
      var priceHistoryResponse = await fetch(baseUrl + args, options);
      if (priceHistoryResponse.status !== 200) {
        throw new Error(
          `failed to fetch price history: ${priceHistoryResponse.status}`
        );
      }
      var priceHistory = await priceHistoryResponse.text();

      res.send(priceHistory);
    } catch (ex) {
      console.log("got error:" + ex);
    }
  })();
});

app.get("/stocks", (req, res) => {
  try {
    Stocks.find({}).then((stocks) => {
      res.json(stocks);
    });
  } catch {
    res.send("error");
  }
});

app.get("/data/:symbol", (req, res) => {
  console.log("in");

  (async () => {
    let symbol = req.params.symbol;

    // Convert symbols like BRK.B to BRK-B to make yahoo happy
    symbol = symbol.replace(/\./g, "-");

    try {
      const resp = await fetch(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=summaryProfile%2CesgScores%2Cprice%2CfinancialData%2CrecommendationTrend%2CdefaultKeyStatistics`
      );

      const data = await resp.json();
      res.send(data);
    } catch {
      res.send("error");
    }
  })();
});

app.get("/sentiment/:symbol", (req, res) => {
  (async function () {
    let symbol = req.params.symbol;

    try {
      const r1 = await twitterapp.get(`/search/tweets`, {
        q: `$${symbol}`, // The search term
        lang: "en", // Let's only get English tweets
        count: 100, // Limit the results to 100 tweets
      });

      let news = await googleNewsAPI.getNews(
        googleNewsAPI.SEARCH,
        `${symbol} stock`,
        "en-GB"
      );

      const stockMsg = await fetch(
        `https://api.stocktwits.com/api/2/streams/symbol/${symbol}.json`
      )
        .then((resp) => resp.json())
        .then((data) => data.messages);

      let messageIndex = 0;
      let counter = 0;

      for (message of stockMsg) {
        if (message.entities.sentiment === null) {
          counter++;
        } else if (message.entities.sentiment.basic === "Bullish") {
          messageIndex++;
          counter++;
        } else if (message.entities.sentiment.basic === "Bearish") {
          messageIndex--;
          counter++;
        }
      }

      let allTweets = "";

      for (tweet of r1.statuses) {
        if (
          tweet.text.toLowerCase().includes(`${symbol.toLowerCase()}`) &&
          tweet.text.length > 20 &&
          !tweet.text.toLowerCase().includes("https")
        )
          allTweets += tweet.text + "\n";
      }

      let allNews = "";

      for (item of news.items) {
        if (
          item.contentSnippet
            .toLowerCase()
            .includes(`${symbol.toLowerCase()}`) &&
          item.contentSnippet.length > 20
        )
          allNews += item.title + "\n";
      }
      const twitterSentimentScore = await getSentimentScore(allTweets);
      const newsSentimentScore = await getSentimentScore(allNews);

      const sentimentObj = {
        twitter: twitterSentimentScore,
        gnews: newsSentimentScore,
        stwits: messageIndex / counter,
      };

      res.send(sentimentObj);
    } catch (e) {
      console.log(e);
    }
  })();
});

app.listen(port, () => console.log(`Server listening`));

async function getSentimentScore(text) {
  const document = {
    content: text,
    type: "PLAIN_TEXT",
  };

  let c = 0;
  let d = 0;
  // Detects the sentiment of the text
  const [result] = await languageClient.analyzeSentiment({
    document: document,
  });
  const sentiment = result.documentSentiment;
  const sentences = result.sentences;
  sentences.forEach((sentence) => {
    {
      d++;
    }
    c += sentence.sentiment.score;
  });

  if (sentiment.score === 0) return c / Math.sqrt(d);
  else return sentiment.score;
}
