
// 商品データ
const sampleProducts = [
  { barcode: "4901234567890", name: "サンプル商品", price: 1500 },
  { barcode: "4900000000001", name: "お菓子サンプル", price: 500 }
];

// 保存済み商品を読み込む
let savedProducts = JSON.parse(
  localStorage.getItem("products") || "[]"
);

// 商品データを保存
function saveProducts() {
  localStorage.setItem("products", JSON.stringify(savedProducts));
}

// JANコード検索
function searchProduct() {
  const barcode = document.getElementById("barcode").value.trim();

  const product = [...savedProducts, ...sampleProducts]
    .find(item => item.barcode === barcode);

  const result = document.getElementById("result");

  if (product) {
    result.textContent =
      `商品名：${product.name} / 価格：${product.price}円 / JANコード：${product.barcode}`;
  } else {
    result.textContent = "商品が見つかりません。";
  }
}

document.getElementById("searchButton")
  .addEventListener("click", searchProduct);

// 商品登録
document.getElementById("addButton")
  .addEventListener("click", function() {
    const barcode = document.getElementById("newBarcode").value.trim();
    const name = document.getElementById("newName").value.trim();
    const priceText = document.getElementById("newPrice").value;

    if (!barcode || !name || priceText === "") {
      alert("すべての項目を入力してください");
      return;
    }

    if (!/^\d{8}$|^\d{12,13}$/.test(barcode)) {
      alert("JANコードを正しく入力してください");
      return;
    }

    if (!Number.isFinite(Number(priceText)) || Number(priceText) < 0) {
      alert("価格は0以上の数字で入力してください");
      return;
    }

    if (savedProducts.some(p => p.barcode === barcode)) {
      alert("このJANコードは登録済みです");
      return;
    }

    savedProducts.push({
      barcode,
      name,
      price: Number(priceText)
    });

    saveProducts();
    showProducts();

    document.getElementById("newBarcode").value = "";
    document.getElementById("newName").value = "";
    document.getElementById("newPrice").value = "";

    alert("商品を登録しました！");
  });

// 商品一覧
function showProducts() {
  const productList = document.getElementById("productList");
  const keyword = document.getElementById("listSearch").value
    .trim().toLowerCase();

  const filteredProducts = savedProducts.filter(product =>
    product.name.toLowerCase().includes(keyword) ||
    product.barcode.includes(keyword)
  );

  productList.innerHTML = "";

  if (savedProducts.length === 0) {
    productList.textContent = "まだ商品が登録されていません";
    return;
  }

  if (filteredProducts.length === 0) {
    productList.textContent = "該当する商品がありません";
    return;
  }

  filteredProducts.forEach(product => {
    const item = document.createElement("div");
    const info = document.createElement("p");

    info.textContent =
      `${product.name} / ${product.price}円 / ${product.barcode}`;

    const editButton = document.createElement("button");
    editButton.textContent = "編集";

    editButton.addEventListener("click", function() {
      const newName = prompt("新しい商品名", product.name);
      if (newName === null || !newName.trim()) return;

      const newPrice = prompt("新しい価格", product.price);
      if (newPrice === null || newPrice.trim() === "") return;

      if (!Number.isFinite(Number(newPrice)) || Number(newPrice) < 0) {
        alert("価格は0以上の数字で入力してください");
        return;
      }

      product.name = newName.trim();
      product.price = Number(newPrice);

      saveProducts();
      showProducts();
    });

    const deleteButton = document.createElement("button");
    deleteButton.textContent = "削除";

    deleteButton.addEventListener("click", function() {
      if (!confirm(product.name + "を削除しますか？")) return;

      savedProducts = savedProducts.filter(
        p => p.barcode !== product.barcode
      );

      saveProducts();
      showProducts();
    });

    item.appendChild(info);
    item.appendChild(editButton);
    item.appendChild(deleteButton);
    productList.appendChild(item);
  });
}

// 商品一覧の自動絞り込み
document.getElementById("listSearch")
  .addEventListener("input", showProducts);

// 起動時に商品一覧を表示
showProducts();


// 商品データのバックアップ
document.getElementById("backupButton")
  .addEventListener("click", function() {

    const backupData = JSON.stringify(savedProducts, null, 2);

    const blob = new Blob(
      [backupData],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = "商品データ_backup.json";

    link.click();

    setTimeout(function() {
      URL.revokeObjectURL(url);
    }, 1000);

    alert("商品データを保存しました！");
});


// 商品データの復元
document.getElementById("restoreButton")
  .addEventListener("click", function() {

    const fileInput = document.getElementById("restoreFile");
    const file = fileInput.files[0];

    if (!file) {
      alert("バックアップファイルを選択してください");
      return;
    }

    if (!confirm("現在の商品データを置き換えて復元しますか？")) {
      return;
    }

    const reader = new FileReader();

    reader.onload = function(event) {
      try {
        const restoredProducts = JSON.parse(event.target.result);

        const valid = Array.isArray(restoredProducts) &&
          restoredProducts.every(function(product) {
            return (
              typeof product.barcode === "string" &&
              typeof product.name === "string" &&
              typeof product.price === "number"
            );
          });

        if (!valid) {
          throw new Error("データ形式が正しくありません");
        }

        savedProducts = restoredProducts;

        saveProducts();
        showProducts();

        alert("商品データを復元しました！");

      } catch (error) {
        alert("復元できませんでした。正しいバックアップファイルか確認してください。");
      }
    };

    reader.readAsText(file);
});


// バーコード読み取り機能
let codeReader = null;

// カメラを完全に停止・解放する
function stopCamera() {
  const video = document.getElementById("camera");
  const stopButton = document.getElementById("stopCameraButton");

  // 現在の映像ストリームを取得
  const stream = video.srcObject;

  // ZXingの読み取りを停止
  if (codeReader) {
    codeReader.reset();
    codeReader = null;
  }

  // カメラのトラックを完全に停止
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }

  // 映像をリセット
  video.pause();
  video.srcObject = null;
  video.removeAttribute("src");
  video.load();

  video.style.display = "none";
  stopButton.style.display = "none";
}

// カメラ起動
document.getElementById("cameraButton")
  .addEventListener("click", async function() {

    const video = document.getElementById("camera");
    const stopButton = document.getElementById("stopCameraButton");

    // 前回のカメラが残っていたら解放
    stopCamera();

    try {
      if (typeof ZXing === "undefined") {
        throw new Error("バーコード読み取りライブラリを読み込めませんでした");
      }

      codeReader = new ZXing.BrowserMultiFormatReader();

      // 映像表示設定
      video.style.display = "block";
      video.style.width = "100%";
      video.style.height = "auto";
      video.style.objectFit = "contain";

      video.setAttribute("playsinline", "");
      video.setAttribute("autoplay", "");
      video.muted = true;

      stopButton.style.display = "inline-block";

      const devices = await codeReader.listVideoInputDevices();

      if (devices.length === 0) {
        throw new Error("カメラが見つかりません");
      }

      const backCamera = devices.find(device =>
        /back|rear|environment/i.test(device.label)
      );

      const cameraId = backCamera
        ? backCamera.deviceId
        : devices[devices.length - 1].deviceId;

      codeReader.decodeFromVideoDevice(
        cameraId,
        video,
        function(result, error) {

          if (result) {
            const barcode = result.getText();

            document.getElementById("barcode").value = barcode;

            stopCamera();

            searchProduct();
          }
        }
      );

    } catch (error) {
      console.error(error);

      stopCamera();

      alert(error.message || "カメラを起動できませんでした");
    }
  });

// カメラ停止ボタン
document.getElementById("stopCameraButton")
  .addEventListener("click", stopCamera);
