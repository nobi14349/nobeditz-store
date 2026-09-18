const productsContainer = document.getElementById("products");

async function loadProducts() {
  try {
    const response = await fetch("/api/products");
    const products = await response.json();

    productsContainer.innerHTML = "";

    if (!products.length) {
      productsContainer.innerHTML = `
        <div class="loading">
          No XML files available yet.
        </div>
      `;
      return;
    }

    products.forEach((product) => {
      const card = document.createElement("div");

      card.className = "product-card";

      card.innerHTML = `
        <h3>${escapeHTML(product.name)}</h3>

        <p>${escapeHTML(product.description || "")}</p>

        <div class="price">
          ₹${Number(product.price).toFixed(0)}
        </div>

        <button class="buy-btn" onclick="buyProduct(${product.id})">
          Buy Now
        </button>
      `;

      productsContainer.appendChild(card);
    });

  } catch (error) {
    console.error(error);

    productsContainer.innerHTML = `
      <div class="loading">
        Unable to load products.
      </div>
    `;
  }
}


async function buyProduct(productId) {

  try {

    const response = await fetch("/api/create-order", {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        productId: productId
      })
    });

    const data = await response.json();

    if (!response.ok) {
      alert(data.error || "Unable to create order.");
      return;
    }


    const options = {

      key: data.keyId,

      amount: data.amount,

      currency: data.currency,

      name: "NOBEDITz",

      description: "Alight Motion XML",

      order_id: data.orderId,


      handler: async function (payment) {

        const verifyResponse = await fetch(
          "/api/verify-payment",
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json"
            },

            body: JSON.stringify(payment)
          }
        );


        const verifyData = await verifyResponse.json();


        if (verifyData.success) {

          window.location.href =
            "/success.html?token=" +
            encodeURIComponent(
              verifyData.downloadToken
            );

        } else {

          alert(
            verifyData.error ||
            "Payment verification failed."
          );

        }
      },


      theme: {
        color: "#008cff"
      }

    };


    const razorpay = new Razorpay(options);

    razorpay.open();


  } catch (error) {

    console.error(error);

    alert(
      "Something went wrong. Please try again."
    );

  }
}


function escapeHTML(value) {

  const div = document.createElement("div");

  div.textContent = value;

  return div.innerHTML;
}


loadProducts();
